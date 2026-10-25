import * as fs from "node:fs";
import * as path from "node:path";

export const METER_SHOW = ["always", "near-expiry", "off"] as const;
export const TERN_PUBLISH = ["auto", "off"] as const;

export interface MeterSettings {
	meter: {
		show: (typeof METER_SHOW)[number];
		warnLeadSeconds: number;
	};
	/** On a cold cache, recommend /compact when it pays back within this many turns (0: never). */
	advice: { paybackTurns: number };
	tern: { publish: (typeof TERN_PUBLISH)[number] };
}

export const DEFAULTS: MeterSettings = {
	meter: { show: "always", warnLeadSeconds: 60 },
	advice: { paybackTurns: 10 },
	tern: { publish: "auto" },
};

// omp's `pi.zod` is a reduced zod whose `.catch` does not cover missing keys, so the file is checked field by
// field: each missing or invalid field takes its default on its own.
const read = (obj: unknown, key: string): unknown => (typeof obj === "object" && obj !== null ? Reflect.get(obj, key) : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.find(a => a === v) ?? fallback;
const count = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

export function parseSettings(raw: unknown): MeterSettings {
	const d = DEFAULTS;
	const meter = read(raw, "meter");
	return {
		meter: {
			show: oneOf(read(meter, "show"), METER_SHOW, d.meter.show),
			warnLeadSeconds: count(read(meter, "warnLeadSeconds"), d.meter.warnLeadSeconds),
		},
		advice: { paybackTurns: count(read(read(raw, "advice"), "paybackTurns"), d.advice.paybackTurns) },
		tern: { publish: oneOf(read(read(raw, "tern"), "publish"), TERN_PUBLISH, d.tern.publish) },
	};
}

/** Reads a settings file; a missing or unparsable file yields the defaults. */
export function loadSettings(file: string): MeterSettings {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		raw = undefined;
	}
	return parseSettings(raw);
}

export function saveSettings(file: string, s: MeterSettings): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
	fs.renameSync(`${file}.tmp`, file);
}
