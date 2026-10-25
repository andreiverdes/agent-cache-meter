import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Snapshot, Tracker } from "./meter";

// The Tern plugin (tern-plugin/window.luau) reads one JSON file per pane from
// <Tern config>/plugin-data/cache-meter/panes/<TERN_PANE>.json. Both hosts write the same v1 shape.

const PANE = process.env.TERN_PANE;
const STATE_DIR = path.join(process.env.TERN_CONFIG_DIR ?? path.join(os.homedir(), "Library", "Application Support", "Tern"), "plugin-data", "cache-meter", "panes");

/** This process's pane file; undefined outside a Tern pane. */
export const PANE_FILE = PANE ? path.join(STATE_DIR, `${PANE}.json`) : undefined;
export const TERN_PANE = PANE;

export interface PaneMeta {
	host: "omp" | "claude";
	/** The agent's folder name. */
	label: string;
	/** `provider/model`. */
	model: string | undefined;
	warnLeadSeconds: number;
}

/** The pane file's body, without `updatedAt`: equal bodies mean nothing changed. */
export function paneState(s: Snapshot, t: Tracker, meta: PaneMeta): string {
	return JSON.stringify({
		v: 1,
		pane: Number(PANE),
		host: meta.host,
		label: meta.label,
		model: meta.model,
		ttlMs: s.ttlMs,
		expiresAt: s.expiresAt,
		tierLabel: s.tierLabel,
		prefixTokens: s.prefixTokens,
		rewriteCost: s.rewriteCost,
		warnLeadSeconds: meta.warnLeadSeconds,
		coldAdvice: s.coldAdvice,
		last: { read: s.last.read, write: s.last.write, uncached: s.last.uncached, total: s.last.total, hitPct: s.last.hitPct },
		warming: s.warming,
		compacted: s.compacted,
		totals: t.totals,
		history: t.history.slice(-20).map(r => ({ kind: r.kind, hitPct: (100 * r.read) / (r.read + r.write + r.uncached) })),
	});
}

/** Writes the pane file atomically, so Tern never reads a half-written one. */
export function writePaneState(body: string): void {
	if (!PANE_FILE) return;
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(`${PANE_FILE}.tmp`, JSON.stringify({ ...JSON.parse(body), updatedAt: Date.now() }));
	fs.renameSync(`${PANE_FILE}.tmp`, PANE_FILE);
}
