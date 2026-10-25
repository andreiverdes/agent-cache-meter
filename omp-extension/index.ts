// cache-meter: prompt-cache meter above omp's composer, the /cache panel and settings, and the per-pane
// state file the Tern plugin of the same name reads.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { CompactionEntry, ExtensionAPI, ExtensionContext, ExtensionUI, Model, Tui } from "./host";
import { type Env, type HostProfile, type Retention, renderMeter, renderPanel, requestedTier, snapshot, Tracker, type WarmingMode } from "./meter";
import { toAnsi, toTsp, type View } from "./view";
import { DEFAULTS, loadSettings, METER_SHOW, type MeterSettings, saveSettings, TERN_PUBLISH } from "./settings";
import { PANE_FILE, paneState, TERN_PANE, writePaneState } from "./tern";

const SETTINGS_FILE = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"), "cache-meter.json");

/** omp warms caches and writes a cold compaction's history to the cache again; `keepRecentTokens` comes from its settings. */
const OMP_HOST: Omit<HostProfile, "keepRecentTokens"> = {
	warmer: true,
	summaryBilledAs: "write",
	coldAdvice: "payback",
	detailsHint: "/cache for details",
	freshCommand: "/new",
	cachingOffHint: "providers.cacheRetention: none",
	priceNote: undefined,
	panelFooter: ["/cache closes", "/cache settings", "/compact", "/new"],
	// omp's native Anthropic compaction wrote 1.2k–3.2k-token summaries in real sessions; thinking tokens come on top.
	summaryTokens: 3000,
	extraAfterTokens: 0,
};

/** What the tracker keeps of a compaction: its sizes, the summary length and the summary request's prompt tokens. */
function compaction(c: CompactionEntry, at: number): NonNullable<Tracker["compacted"]> {
	const native: unknown = typeof c.preserveData === "object" && c.preserveData !== null ? Reflect.get(c.preserveData, "anthropicCompaction") : undefined;
	const used: unknown = typeof native === "object" && native !== null ? Reflect.get(native, "usedTokens") : undefined;
	return {
		at,
		tokensBefore: c.tokensBefore,
		tokensAfter: c.tokensAfter,
		summaryTokens: Math.round((c.summary?.length ?? 0) / 4),
		usedTokens: typeof used === "number" ? used : undefined,
	};
}

export default function cacheMeter(pi: ExtensionAPI): void {
	const tracker = new Tracker();
	let settings = loadSettings(SETTINGS_FILE);
	let model: Model | undefined;
	let agentRunning = false;
	let ui: ExtensionUI | undefined;
	let tui: Tui | undefined;
	let meterShown = false;
	let panelOpen = false;
	let published = "";
	let timer: unknown;
	let cwd = process.cwd();

	const env = (): Env => {
		const retention = lookup("providers.cacheRetention")?.get(pi.pi.settings);
		const mode = lookup("providers.cacheWarming")?.get(pi.pi.settings);
		const keep = lookup("compaction.keepRecentTokens")?.get(pi.pi.settings);
		return {
			now: Date.now(),
			settings,
			model,
			retention: retention === "short" || retention === "long" || retention === "none" ? (retention satisfies Retention) : "auto",
			warmingMode: mode === "off" || mode === "streaming" ? (mode satisfies WarmingMode) : "idle",
			agentRunning,
			host: { ...OMP_HOST, keepRecentTokens: typeof keep === "number" && keep > 0 ? keep : 20_000 },
		};
	};

	// Seeds history from the session so a resumed session shows its real countdown.
	const rebuild = (ctx: ExtensionContext): void => {
		tracker.reset();
		model = ctx.model;
		cwd = ctx.cwd;
		for (const e of ctx.sessionManager.getBranch()) {
			const at = Date.parse(e.timestamp);
			if (e.type === "message" && e.message.role === "assistant" && e.message.usage) tracker.record("turn", e.message.usage, at, model);
			else if (e.type === "model_usage" && e.purpose.startsWith("cache-warm")) tracker.record("warm", e.usage, at, model);
			else if (e.type === "compaction") tracker.compacted = compaction(e, at);
		}
		published = "";
	};

	// Only the interactive session owns the pane's file: subagent and print-mode sessions have no UI and
	// would otherwise overwrite or delete it.
	const publish = (): void => {
		if (!PANE_FILE || !ui || settings.tern.publish === "off") return;
		const s = snapshot(tracker, env());
		if (!s) return;
		const meta = { host: "omp" as const, label: path.basename(cwd), model: model ? `${model.provider}/${model.id}` : undefined, warnLeadSeconds: settings.meter.warnLeadSeconds };
		const body = paneState(s, tracker, meta);
		if (body === published) return;
		published = body;
		writePaneState(body);
	};

	// The meter widget exists only while it has something to show, so a hidden meter leaves no blank row.
	const syncMeter = (): void => {
		if (!ui) return;
		const s = snapshot(tracker, env());
		const show = settings.meter.show;
		const want = s !== undefined && show !== "off" && !(show === "near-expiry" && (s.stage === "warm" || s.stage === "compacted"));
		if (want && !meterShown) {
			// The view is rebuilt on every paint so the countdown moves; describe() feeds native hosts (Tern).
			const view = (): View => {
				const now = snapshot(tracker, env());
				return now ? renderMeter(now, env()) : { tone: "muted", blocks: [] };
			};
			ui.setWidget(
				"cache-meter",
				(t, theme) => {
					tui = t;
					return {
						render: width => toAnsi(view(), theme, width),
						describe: () => toTsp(view(), "omp.widget.cache-meter"),
						invalidate() {},
					};
				},
				{ placement: "aboveEditor" },
			);
		} else if (!want && meterShown) {
			ui.setWidget("cache-meter", undefined);
		}
		meterShown = want;
	};

	const showPanel = (): void => {
		const view = () => renderPanel(tracker, snapshot(tracker, env()), env());
		ui?.setWidget(
			"cache-panel",
			panelOpen
				? (t, theme) => {
						tui = t;
						return {
							render: width => toAnsi(view(), theme, width),
							describe: () => toTsp(view(), "omp.widget.cache-panel"),
							invalidate() {},
						};
					}
				: undefined,
			{ placement: "aboveEditor" },
		);
	};

	const refresh = (): void => {
		syncMeter();
		tui?.requestRender();
		publish();
	};

	pi.on("session_start", (_e, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		rebuild(ctx);
		if (timer === undefined) timer = ctx.setInterval(refresh, 1000);
		refresh();
	});
	for (const event of ["session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, (_e, ctx) => {
			rebuild(ctx);
			refresh();
		});
	}
	pi.on("agent_start", () => {
		agentRunning = true;
	});
	pi.on("agent_end", () => {
		agentRunning = false;
		refresh();
	});

	pi.on("message_end", (e, ctx) => {
		if (e.message.role !== "assistant" || !e.message.usage) return;
		model = ctx.model ?? model;
		if (tracker.record("turn", e.message.usage, Date.now(), model)) refresh();
	});

	pi.on("before_provider_request", e => {
		tracker.requestedTier = requestedTier(e.payload) ?? tracker.requestedTier;
		return undefined; // observe only; the payload goes out unchanged
	});

	pi.on("cache_warming_decision", e => {
		tracker.decision = { at: Date.now(), action: e.action, warmCost: e.warmCost, missCost: e.missCost };
		refresh();
		return undefined; // observe only; omp's own decision stands
	});
	pi.on("cache_warming_end", e => {
		if (e.usage) tracker.record("warm", e.usage, Date.now(), model);
		if (e.warmingStopReason) tracker.stopped = { at: Date.now(), reason: e.warmingStopReason };
		refresh();
	});

	// /compact replaces the conversation, so the cached prefix stops mattering: the meter switches to the
	// compacted state until the next turn writes the new prefix.
	pi.on("session_compact", e => {
		const c = e.compactionEntry;
		tracker.compacted = compaction(c, Date.parse(c.timestamp) || Date.now());
		refresh();
	});

	pi.on("session_shutdown", () => {
		if (PANE_FILE && ui) fs.rmSync(PANE_FILE, { force: true });
	});

	const editSettings = async (ctx: ExtensionContext): Promise<void> => {
		for (;;) {
			const s = settings;
			const omp = (id: string) => `${id}: ${String(lookup(id)?.get(pi.pi.settings) ?? "?")} (change in /settings)`;
			const entries: [string, () => Promise<MeterSettings | undefined>][] = [
				[`Show meter: ${s.meter.show}`, async () => {
					const v = await ctx.ui.select("Show meter", [...METER_SHOW]);
					return v ? { ...s, meter: { ...s.meter, show: v as MeterSettings["meter"]["show"] } } : undefined;
				}],
				[`Warn before expiry: ${s.meter.warnLeadSeconds} s`, async () => {
					const n = Number(await ctx.ui.input("Warn this many seconds before expiry", String(s.meter.warnLeadSeconds)));
					return Number.isFinite(n) && n >= 0 ? { ...s, meter: { ...s.meter, warnLeadSeconds: n } } : undefined;
				}],
				[`Recommend /compact when it pays back within: ${s.advice.paybackTurns} turns (0 = never)`, async () => {
					const n = Number(await ctx.ui.input("On a cold cache, recommend /compact when it pays back within this many turns (0 = never)", String(s.advice.paybackTurns)));
					return Number.isFinite(n) && n >= 0 ? { ...s, advice: { paybackTurns: Math.round(n) } } : undefined;
				}],
				[`Publish state for Tern: ${s.tern.publish}${TERN_PANE ? ` (TERN_PANE=${TERN_PANE})` : " (not in a Tern pane)"}`, async () => {
					const v = await ctx.ui.select("Publish state for Tern", [...TERN_PUBLISH]);
					return v ? { ...s, tern: { publish: v as MeterSettings["tern"]["publish"] } } : undefined;
				}],
				[omp("providers.cacheRetention"), async () => undefined],
				[omp("providers.cacheWarming"), async () => undefined],
				[omp("display.cacheMissMarker"), async () => undefined],
				["Reset to defaults", async () => DEFAULTS],
				["Done", async () => undefined],
			];
			const choice = await ctx.ui.select(`Cache · settings (${SETTINGS_FILE.replace(os.homedir(), "~")})`, entries.map(([label]) => label));
			if (!choice || choice === "Done") return;
			if (choice.startsWith("providers.") || choice.startsWith("display.")) {
				ctx.ui.notify("That is an omp setting: change it in /settings.", "info");
				continue;
			}
			const next = await entries.find(([label]) => label === choice)?.[1]();
			if (!next) continue;
			settings = next;
			saveSettings(SETTINGS_FILE, settings);
			if (settings.tern.publish === "off" && PANE_FILE) fs.rmSync(PANE_FILE, { force: true });
			published = "";
			refresh();
		}
	};

	pi.registerCommand("cache", {
		description: "Cache: toggle the history panel; `/cache settings` changes the meter.",
		getArgumentCompletions: prefix =>
			"settings".startsWith(prefix.trim()) ? [{ label: "settings", value: "settings", description: "Meter, advice and Tern settings" }] : null,
		handler: async (args, ctx) => {
			ui = ctx.hasUI ? ctx.ui : ui;
			if (args.trim() === "settings") {
				await editSettings(ctx);
				return;
			}
			panelOpen = !panelOpen;
			showPanel();
		},
	});
}
