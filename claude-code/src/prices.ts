import * as fs from "node:fs";

/** USD per million tokens. `write1h` is the one-hour cache-write rate. */
export interface Rates {
	input: number;
	output: number;
	write5m: number;
	write1h: number;
	read: number;
}

interface Tier extends Rates {
	/** Rates for requests whose prompt (input + cache read + cache write) is above `above` tokens. */
	longPrompt?: Rates & { above: number };
}

// List prices from the model catalog Claude Code 2.1.302 ships (its `pricing` tiers and each model's tier).
const r = (input: number, output: number, read: number): Rates => ({ input, output, write5m: input * 1.25, write1h: input * 2, read });
const TIERS = {
	haiku_35: r(0.8, 4, 0.08),
	haiku_45: r(1, 5, 0.1),
	haiku_55: { ...r(0.1, 0.5, 0.01), longPrompt: { ...r(0.5, 2.5, 0.05), above: 100_000 } },
	tier_2_10: r(2, 10, 0.2),
	tier_2_10_cache_read_0_10: r(2, 10, 0.1),
	tier_3_15: r(3, 15, 0.3),
	tier_4_20_cache_read_0_20: r(4, 20, 0.2),
	tier_5_25: r(5, 25, 0.5),
	tier_10_50: r(10, 50, 1),
	tier_10_50_cache_read_0_25: r(10, 50, 0.25),
	tier_15_75: r(15, 75, 1.5),
} satisfies Record<string, Tier>;

/** Model id prefixes, longest first so `claude-opus-4-5` wins over `claude-opus-4`. Dated and `[1m]` ids match their prefix. */
const MODELS: [string, Tier][] = (
	[
		["claude-3-5-haiku", TIERS.haiku_35],
		["claude-haiku-4-5", TIERS.haiku_45],
		["claude-haiku-5-5", TIERS.haiku_55],
		["claude-3-5-sonnet", TIERS.tier_3_15],
		["claude-3-7-sonnet", TIERS.tier_3_15],
		["claude-sonnet-4-0", TIERS.tier_3_15],
		["claude-sonnet-4-5", TIERS.tier_3_15],
		["claude-sonnet-4-6", TIERS.tier_3_15],
		["claude-sonnet-5-5", TIERS.tier_2_10_cache_read_0_10],
		["claude-sonnet-5", TIERS.tier_2_10],
		["claude-opus-4-0", TIERS.tier_15_75],
		["claude-opus-4-1", TIERS.tier_15_75],
		["claude-opus-4-5", TIERS.tier_5_25],
		["claude-opus-4-6", TIERS.tier_5_25],
		["claude-opus-4-7", TIERS.tier_5_25],
		["claude-opus-4-8", TIERS.tier_5_25],
		["claude-opus-5-5", TIERS.tier_4_20_cache_read_0_20],
		["claude-opus-5", TIERS.tier_5_25],
		["claude-fable-5-1", TIERS.tier_10_50_cache_read_0_25],
		["claude-fable-5", TIERS.tier_10_50],
		["claude-mythos-5-1", TIERS.tier_10_50_cache_read_0_25],
		["claude-mythos-5", TIERS.tier_10_50],
	] satisfies [string, Tier][]
).sort((a, b) => b[0].length - a[0].length);

// Claude Code reads `modelPricing` from managed settings only; the file is the one mechanism a script can read.
const MANAGED_SETTINGS =
	process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode\\managed-settings.json" : "/etc/claude-code/managed-settings.json";

const num = (o: unknown, key: string): number | undefined => {
	const v: unknown = typeof o === "object" && o !== null ? Reflect.get(o, key) : undefined;
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
};

/** The organisation's `modelPricing` from managed-settings.json, when one is set. */
function contracted(): { multiplier: number; overrides: Map<string, Rates> } | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(MANAGED_SETTINGS, "utf8"));
	} catch {
		return undefined;
	}
	const mp: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, "modelPricing") : undefined;
	if (typeof mp !== "object" || mp === null) return undefined;
	const overrides = new Map<string, Rates>();
	const rows: unknown = Reflect.get(mp, "overrides");
	if (typeof rows === "object" && rows !== null) {
		for (const [id, row] of Object.entries(rows)) {
			const [input, output, read, write] = [num(row, "input"), num(row, "output"), num(row, "cacheRead"), num(row, "cacheWrite")];
			// `cacheWrite` covers both cache lifetimes.
			if (input !== undefined && output !== undefined && read !== undefined && write !== undefined) overrides.set(id, { input, output, read, write5m: write, write1h: write });
		}
	}
	return { multiplier: num(mp, "multiplier") ?? 1, overrides };
}

const ORG = contracted();

export interface Pricing {
	/** Rates for a request with this many prompt tokens. */
	rates(promptTokens: number): Rates;
	/** True when the rates are the organisation's contracted ones rather than list prices. */
	contracted: boolean;
}

/** The rates for a model id, or undefined for a model the table doesn't know. */
export function pricing(modelId: string): Pricing | undefined {
	const org = ORG;
	const scale = (x: Rates): Rates => {
		const m = org?.multiplier ?? 1;
		return { input: x.input * m, output: x.output * m, write5m: x.write5m * m, write1h: x.write1h * m, read: x.read * m };
	};
	const builtin = MODELS.find(([prefix]) => modelId.startsWith(prefix));
	const override = org?.overrides.get(modelId) ?? (builtin ? org?.overrides.get(builtin[0]) : undefined);
	if (override) return { rates: () => scale(override), contracted: true };
	if (!builtin) return undefined;
	const tier: Tier = builtin[1];
	return { rates: n => scale(tier.longPrompt && n > tier.longPrompt.above ? tier.longPrompt : tier), contracted: org !== undefined };
}
