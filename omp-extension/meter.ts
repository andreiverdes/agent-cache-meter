import type { Model, Usage } from "./host";
import type { MeterSettings } from "./settings";
import type { Block, Cell, Item, Span, Tone, View } from "./view";

export type Tier = "short" | "long";
export type WarmingMode = "off" | "streaming" | "idle";
export type Retention = "auto" | "short" | "long" | "none";
/** `compacted`: /compact replaced the conversation after the last request, so the cached prefix is no longer used. */
export type Stage = "warm" | "expiring" | "cold" | "compacted";

export interface Req {
	at: number;
	kind: "turn" | "warm";
	read: number;
	write: number;
	uncached: number;
	cost: number;
	/** The first turn after a compaction: its cache write is the new prefix, not a miss. */
	afterCompact?: true;
}

/** USD per token. */
interface Price {
	input: number;
	output: number;
	read: number;
	write: number;
}

const TEN_S = 10_000;
const IDLE_WINDOW_MS = 30 * 60_000; // omp stops idle warming 30 min after the last request
const RUN_LIMIT_MS = 60 * 60_000; // omp never schedules a refresh more than 1 h out
const LONG_WRITE_FACTOR = 1.6; // Anthropic 1h writes cost 2× input, 5m writes 1.25×

/** Per-session request history and running totals; rebuilt from the session branch on load. */
export class Tracker {
	history: Req[] = [];
	totals = { saved: 0, warmCost: 0, warms: 0, misses: 0, missCost: 0 };
	observedTier: Tier | undefined;
	/** Tier the latest request asked for (`cache_control.ttl`); survives resets, it follows the credential. */
	requestedTier: Tier | undefined;
	/** Last warming decision or stop omp reported, with when it happened. */
	decision: { at: number; action: "warm" | "stop"; warmCost: number; missCost: number } | undefined;
	stopped: { at: number; reason: string } | undefined;
	/** The latest compaction, until the next turn sends the new prefix. `usedTokens`: the summary request's prompt. */
	compacted: { at: number; tokensBefore: number; tokensAfter: number | undefined; summaryTokens: number; usedTokens: number | undefined } | undefined;

	reset(): void {
		this.history = [];
		this.totals = { saved: 0, warmCost: 0, warms: 0, misses: 0, missCost: 0 };
		this.observedTier = undefined;
		this.decision = undefined;
		this.stopped = undefined;
		this.compacted = undefined;
	}

	/** Adds one request; returns false when it carried no prompt tokens (errors, aborts). */
	record(kind: Req["kind"], usage: Usage, at: number, model: Model | undefined): boolean {
		const r: Req = { at, kind, read: usage.cacheRead, write: usage.cacheWrite, uncached: usage.input, cost: usage.cost.total };
		if (r.read + r.write + r.uncached === 0) return false;
		const price = priceOf(model, this.requestedTier ?? this.observedTier);
		if (usage.cttl?.ephemeral1h) this.observedTier = "long";
		else if (usage.cttl?.ephemeral5m) this.observedTier = "short";
		this.totals.saved += r.read * (price.input - price.read);
		if (kind === "warm") {
			this.totals.warms++;
			this.totals.warmCost += r.cost;
		}
		if (kind === "turn" && this.compacted) {
			r.afterCompact = true;
			this.compacted = undefined;
		} else if (this.history.length > 0 && r.read === 0 && r.write > 0) {
			this.totals.misses++;
			this.totals.missCost += r.write * price.write;
		}
		this.history.push(r);
		return true;
	}
}

/**
 * The cache tier an Anthropic Messages payload requests: `cache_control.ttl` on a system block or the last
 * message's content. Other payload shapes yield undefined.
 */
export function requestedTier(payload: unknown): Tier | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const blocks: unknown[] = [];
	if ("system" in payload && Array.isArray(payload.system)) blocks.push(...payload.system);
	if ("messages" in payload && Array.isArray(payload.messages)) {
		const last: unknown = payload.messages.at(-1);
		if (typeof last === "object" && last !== null && "content" in last && Array.isArray(last.content)) blocks.push(...last.content);
	}
	for (const b of blocks) {
		if (typeof b !== "object" || b === null || !("cache_control" in b)) continue;
		const cc: unknown = b.cache_control;
		if (typeof cc !== "object" || cc === null) continue;
		return "ttl" in cc && cc.ttl === "1h" ? "long" : "short";
	}
	return undefined;
}

function priceOf(model: Model | undefined, tier: Tier | undefined): Price {
	const c = model?.cost;
	if (!c) return { input: 0, output: 0, read: 0, write: 0 };
	const longFactor = tier === "long" && model?.api === "anthropic-messages" ? LONG_WRITE_FACTOR : 1;
	return { input: c.input / 1e6, output: c.output / 1e6, read: c.cacheRead / 1e6, write: (c.cacheWrite / 1e6) * longFactor };
}

/** What differs between the hosts the meter runs in (omp, Claude Code). */
export interface HostProfile {
	/** Whether the host refreshes the cache before it expires (omp's cache warmer). */
	warmer: boolean;
	/** How a compaction's summary request pays for the history: written to the cache again, or sent as plain input. */
	summaryBilledAs: "write" | "input";
	/** On a cold cache: recommend /compact when it pays back within `advice.paybackTurns`, or always. */
	coldAdvice: "payback" | "always";
	/** The recent conversation a compaction keeps verbatim. */
	keepRecentTokens: number;
	/** A compaction summary's size in tokens, before the host reports the real one. */
	summaryTokens: number;
	/** What the host adds back after a compaction beyond the head, summary and kept turns (re-read files, todos). */
	extraAfterTokens: number;
	/** Where the meter points for details: `/cache for details`. */
	detailsHint: string;
	/** The command that starts over without the conversation: `/new`, `/clear`. */
	freshCommand: string;
	/** Why the meter says caching is off: the host setting or observation behind it. */
	cachingOffHint: string;
	/** Shown beside dollar amounts that aren't a bill, such as list prices on a subscription; undefined for none. */
	priceNote: string | undefined;
	/** The commands listed at the foot of the panel. */
	panelFooter: string[];
}

export interface Env {
	now: number;
	settings: MeterSettings;
	model: Model | undefined;
	retention: Retention;
	warmingMode: WarmingMode;
	agentRunning: boolean;
	host: HostProfile;
}

/** What /compact would cost on a cold cache against continuing, and how fast it pays back. */
export interface CompactPlan {
	/** Estimated context after the compaction: tools and system prompt, the summary and the kept recent turns. */
	afterTokens: number;
	/** The summary request: the summarised conversation rewritten to the cache, plus the summary as output. */
	summaryCost: number;
	/** The first request after it, writing the new prefix. */
	afterCost: number;
	/** summaryCost + afterCost − the rebuild as is: negative when /compact is cheaper now. */
	extra: number;
	/** Turns until the smaller prefix's cheaper reads cover `extra`; 0 when /compact is cheaper now. */
	paybackTurns: number;
	/** How much less every later rebuild of the cache costs. */
	laterRebuildSaving: number;
	recommended: boolean;
}

/** Everything the meter, the panel and Tern show; time-dependent fields are computed from `now`. */
export interface Snapshot {
	last: Req & { total: number; hitPct: number };
	/** The prefix the next request sends: the last request's prompt, or the compacted context after /compact. */
	prefixTokens: number;
	/** The tools and static system prompt: shared across omp sessions, so still cached when this one goes cold. */
	headTokens: number;
	tier: Tier;
	tierSource: "observed" | "assumed";
	/** "5m tier", "1h tier (assumed)". */
	tierLabel: string;
	ttlMs: number;
	expiresAt: number;
	leftMs: number;
	/** What the next request pays to rebuild the prefix once the cache has expired. */
	rewriteCost: number;
	/** Set on a cold cache when the model is priced. */
	plan: CompactPlan | undefined;
	coldAdvice: "compact" | "continue";
	/** `reason` says, in plain words, why no refresh is planned; undefined while one is. */
	warming: { scheduled: boolean; nextWarmAt: number | undefined; refreshCost: number; summary: string; reason: string | undefined };
	stage: Stage;
	advice: "continue" | "send now" | "compact";
	/**
	 * Set while a compaction is newer than the last request; `tokensAfter` is the host's estimate when it has one.
	 * `perTurn`: how much less each later request pays to read the smaller prefix from the cache.
	 * `result`: set when the cache had already expired at the compaction. `avoided` is the rebuild of the old prefix,
	 * `summary` the summary request, `after` the next request writing the new prefix; `net` = avoided − summary − after.
	 */
	compacted:
		| {
				tokensBefore: number;
				tokensAfter: number | undefined;
				perTurn: number | undefined;
				result: { avoided: number; summary: number; after: number; net: number } | undefined;
		  }
		| undefined;
	cachingOff: boolean;
}

/** omp's refresh delay for an entry lifetime (cache-warmer.ts): 90 % of it, at least 10 s before expiry. */
export function warmDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= TEN_S) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - TEN_S)));
}

export function snapshot(t: Tracker, env: Env): Snapshot | undefined {
	const last = t.history.at(-1);
	if (!last) return undefined;
	const total = last.read + last.write + last.uncached;
	const known = t.requestedTier ?? t.observedTier;
	const tier: Tier = known ?? (env.retention === "long" ? "long" : "short");
	const declared = env.model?.promptCache?.[tier];
	const ttlMs = (declared ?? (tier === "long" ? 3600 : 300)) * 1000;
	const expiresAt = last.at + ttlMs;
	const leftMs = expiresAt - env.now;
	const price = priceOf(env.model, tier);
	// The session's first request reads only what other sessions keep warm: the tools and static system prompt.
	const head = Math.min(t.history[0]?.read ?? 0, total);
	// Rebuilding n prompt tokens on an expired cache: the shared head is read, the rest written again.
	const rebuild = (n: number): number => Math.max(0, n - head) * price.write + Math.min(n, head) * price.read;
	// A cold summary request over n tokens: omp writes the history to the cache again, Claude Code sends it as input.
	const summarise = (n: number): number =>
		env.host.summaryBilledAs === "write" ? rebuild(n) : Math.max(0, n - head) * price.input + Math.min(n, head) * price.read;
	// After /compact the next request sends the summary instead of the cached conversation: a new prefix.
	const c = t.compacted && t.compacted.at >= last.at ? t.compacted : undefined;
	const prefixTokens = c ? (c.tokensAfter ?? 0) : total;
	const rewriteCost = rebuild(prefixTokens);
	let compacted: Snapshot["compacted"];
	if (c) {
		const used = c.usedTokens ?? Math.max(0, c.tokensBefore - env.host.keepRecentTokens);
		const priced = price.write > 0 && c.tokensAfter !== undefined;
		const perTurn = priced && c.tokensAfter !== undefined ? Math.max(0, c.tokensBefore - c.tokensAfter) * price.read : undefined;
		let result: NonNullable<Snapshot["compacted"]>["result"];
		if (priced && c.at >= expiresAt) {
			const avoided = rebuild(c.tokensBefore);
			const summary = summarise(used) + c.summaryTokens * price.output;
			result = { avoided, summary, after: rewriteCost, net: avoided - summary - rewriteCost };
		}
		compacted = { tokensBefore: c.tokensBefore, tokensAfter: c.tokensAfter, perTurn, result };
	}

	// Mirror of omp's warmer rules (cache-warmer.ts); omp does not expose its live status to extensions.
	const delay = env.host.warmer ? warmDelayMs(ttlMs) : undefined;
	const nextWarmAt = delay === undefined ? undefined : last.at + delay;
	let reason: string | undefined;
	if (env.retention === "none") reason = "caching is off";
	else if (!env.host.warmer) reason = "nothing refreshes the cache while you're idle";
	else if (env.warmingMode === "off") reason = "cache warming is off in /settings";
	else if (declared === undefined || nextWarmAt === undefined) reason = "the model declares no cache lifetime";
	else if (t.stopped && t.stopped.at >= last.at) reason = t.stopped.reason;
	else if (t.decision && t.decision.at >= last.at && t.decision.action === "stop") reason = "omp judged a refresh not worth it";
	else if (env.agentRunning) {
		if (nextWarmAt > last.at + RUN_LIMIT_MS) reason = "past omp's 1 h refresh limit";
	} else if (env.warmingMode === "streaming") reason = "streaming warming stops when you go idle";
	else if (delay !== undefined && delay >= IDLE_WINDOW_MS) reason = "omp only refreshes 5m caches while idle, and this one is 1h";
	else if (nextWarmAt > last.at + IDLE_WINDOW_MS) reason = "omp stops refreshing 30 min after your last message";
	const scheduled = reason === undefined && !c && nextWarmAt !== undefined && nextWarmAt > env.now;
	// No rule fired but the refresh time passed: after refreshes, the 30 min idle limit; otherwise omp never got to it.
	if (!scheduled && reason === undefined) reason = last.kind === "warm" ? "omp stops refreshing 30 min after your last message" : "no refresh ran in time";
	const d = t.decision && t.decision.at >= last.at ? t.decision : undefined;
	// A refresh resends the prefix and reads it from the cache.
	const refreshCost = d ? d.warmCost : prefixTokens * price.read;
	let summary: string;
	if (scheduled && delay !== undefined) {
		summary = `warming at ${clock((ttlMs - delay) / 1000)} left`;
		if (d) summary += ` · refresh $${d.warmCost.toFixed(2)} vs miss $${d.missCost.toFixed(2)}`;
	} else {
		summary = c ? "old prefix dropped by /compact" : env.host.warmer ? `not warmed: ${reason}` : "no cache warmer";
	}

	const leadMs = env.settings.meter.warnLeadSeconds * 1000;
	const stage: Stage = c ? "compacted" : leftMs <= 0 ? "cold" : leftMs <= leadMs && !scheduled ? "expiring" : "warm";
	let plan: CompactPlan | undefined;
	if (stage === "cold" && price.write > 0) {
		// omp's native Anthropic compaction sends the live prefix up to the kept turns, with cache markers: on an
		// expired cache that part is written again (Claude Code sends it as input). The context after it is the head,
		// the summary and the kept turns.
		const kept = Math.min(env.host.keepRecentTokens, Math.max(0, total - head));
		const afterTokens = Math.min(total, head + env.host.summaryTokens + kept + env.host.extraAfterTokens);
		const summaryCost = summarise(total - kept) + env.host.summaryTokens * price.output;
		const afterCost = rebuild(afterTokens);
		const extra = summaryCost + afterCost - rewriteCost;
		const perTurn = (total - afterTokens) * price.read;
		const paybackTurns = extra <= 0 ? 0 : perTurn > 0 ? Math.ceil(extra / perTurn) : Number.POSITIVE_INFINITY;
		const limit = env.settings.advice.paybackTurns;
		const recommended = env.host.coldAdvice === "always" || (limit > 0 && paybackTurns <= limit);
		plan = { afterTokens, summaryCost, afterCost, extra, paybackTurns, laterRebuildSaving: rewriteCost - afterCost, recommended };
	}
	const coldAdvice = plan?.recommended || (stage === "cold" && env.host.coldAdvice === "always") ? "compact" : "continue";
	const advice = stage === "cold" ? coldAdvice : stage === "expiring" ? "send now" : "continue";
	return {
		last: { ...last, total, hitPct: total > 0 ? (100 * last.read) / total : 0 },
		prefixTokens,
		headTokens: head,
		tier,
		tierSource: known ? "observed" : "assumed",
		tierLabel: `${tier === "long" ? "1h" : "5m"} tier${known ? "" : " (assumed)"}`,
		ttlMs,
		expiresAt,
		leftMs,
		rewriteCost,
		plan,
		coldAdvice,
		warming: { scheduled, nextWarmAt, refreshCost, summary, reason: scheduled ? undefined : reason },
		stage,
		advice,
		compacted,
		cachingOff: env.retention === "none",
	};
}

// ── views ──────────────────────────────────────────────────────────────────
// Renderers build a View (view.ts) once; toAnsi pads it for the terminal TUI, toTsp describes it for native
// hosts such as Tern.

export function tokens(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

export function clock(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A past span: `4:12` under an hour, then `3h 05m`, then `2d 4h`. */
export function elapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	if (s < 3600) return clock(s);
	if (s < 86_400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
	return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** The colour of a stage: the meter's edge, badge, countdown and advice. */
export function stageTone(stage: Stage): Tone {
	return stage === "cold" ? "error" : stage === "expiring" ? "warning" : stage === "compacted" ? "accent" : "success";
}

const STAGE_BADGE: Record<Stage, string> = { warm: "warm", expiring: "expires soon", cold: "cold", compacted: "reset by /compact" };
const muted = (text: string): Span[] => [{ text, tone: "muted" }];
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** A request's read / write / uncached split as a stacked bar: green, accent, amber. */
function splitBar(r: Pick<Req, "read" | "write" | "uncached">): { bar: [number, Tone][] } {
	const total = r.read + r.write + r.uncached || 1;
	return { bar: [[r.read / total, "success"], [r.write / total, "accent"], [r.uncached / total, "warning"]] };
}

/** `/compact recommended · ≈ $0.82 · save ~$0.15`, or why continuing is the better call. */
function compactAdvice(p: CompactPlan): Span[] {
	if (!p.recommended) {
		const why = Number.isFinite(p.paybackTurns) ? `pays back only after ~${p.paybackTurns} turns` : "would not pay back";
		return [{ text: "continue", tone: "accent" }, { text: " recommended", tone: "success" }, ...muted(` · /compact ${why}`)];
	}
	const cheaper = p.extra <= 0;
	const net: Span[] = cheaper
		? [{ text: `save ~${usd(-p.extra)}`, tone: "success" }]
		: [{ text: `+${usd(p.extra)} now`, tone: "warning" }, ...muted(`, pays back in ~${p.paybackTurns} turns`)];
	return [
		{ text: "/compact", tone: "accent" },
		{ text: " recommended", tone: "success" },
		...muted(" · "),
		{ text: `≈ ${usd(p.summaryCost + p.afterCost)}`, tone: cheaper ? "success" : "warning" },
		...muted(" · "),
		...net,
	];
}

/**
 * The meter above the composer: one line while warm, expiring or just compacted, two when cold. What happened is
 * on the left; the hit bar, hit rate and time (or the sizes) sit at the right end. Empty when settings hide it now.
 */
export function renderMeter(s: Snapshot, env: Pick<Env, "settings" | "host">): View {
	const tone = stageTone(s.stage);
	const show = env.settings.meter.show;
	if (show === "off" || (show === "near-expiry" && (s.stage === "warm" || s.stage === "compacted"))) return { tone, blocks: [] };
	if (s.cachingOff) return { tone: "muted", blocks: [{ kind: "bar", left: [muted("⛁ caching off")], right: [muted(env.host.cachingOffHint)] }] };
	const title: Item[] = [[{ text: "⛁ cache", tone: "strong" }], { badge: STAGE_BADGE[s.stage], tone }];
	const note = env.host.priceNote ? muted(` · ${env.host.priceNote}`) : [];
	const rebuild: Span[] = [...muted(`rebuild cost ${tokens(s.prefixTokens)} ≈ `), { text: usd(s.rewriteCost), tone: s.stage === "cold" ? "error" : "warning" }];

	if (s.compacted) {
		const { tokensBefore, tokensAfter, perTurn, result } = s.compacted;
		if (tokensAfter === undefined) {
			return { tone, blocks: [{ kind: "bar", left: [...title, muted("the next request writes the new prefix")], right: [[{ text: tokens(tokensBefore) }, ...muted(" → ?")]] }] };
		}
		// What /compact changes for every later turn first, then its one-off result: they are different amounts.
		const gain: Span[] =
			perTurn === undefined
				? [{ text: `${tokens(tokensBefore - tokensAfter)} fewer tokens per turn`, tone: "success" }]
				: [{ text: `~${usd(perTurn)} less per turn`, tone: "success" }];
		if (result && result.net >= 0) gain.push(...muted(" · paid for itself "), { text: `(~${usd(result.net)})`, tone: "success" });
		else if (result) gain.push(...muted(" · "), { text: `+${usd(-result.net)} now`, tone: "warning" });
		// The least important part last, so a narrow meter cuts it first.
		gain.push(...muted(` · next ≈ ${usd(s.rewriteCost)}`), ...note);
		return { tone, blocks: [{ kind: "bar", left: [...title, gain], right: [[{ text: tokens(tokensBefore) }, ...muted(" → "), { text: tokens(tokensAfter), tone: "accent" }]] }] };
	}

	if (s.stage === "cold") {
		const ago = `${s.tier === "long" ? "1h" : "5m"} · expired | ${elapsed(-s.leftMs / 1000)} ago`;
		const recommendCompact: Span[] = [{ text: "/compact", tone: "accent" }, { text: " recommended", tone: "success" }, ...muted(" · smaller prefix, cheaper turns")];
		const advice = s.plan ? compactAdvice(s.plan) : s.coldAdvice === "compact" ? recommendCompact : muted(`continue, /compact or ${env.host.freshCommand}`);
		return {
			tone,
			blocks: [
				{ kind: "bar", left: [...title, [...rebuild, ...note]], right: [muted(ago)] },
				{ kind: "bar", left: [advice], right: [muted(env.host.detailsHint)] },
			],
		};
	}

	const r = s.last;
	const left: Span[] =
		s.stage === "expiring"
			? [...rebuild, ...muted(" after"), ...note]
			: [
					{ text: "read ", tone: "success" },
					{ text: tokens(r.read) },
					...muted(" · "),
					{ text: "write ", tone: "accent" },
					{ text: tokens(r.write) },
					...muted(" · "),
					{ text: "uncached ", tone: "warning" },
					{ text: tokens(r.uncached) },
				];
	const hit: Span[] = [{ text: `${r.hitPct.toFixed(1)}%`, tone: "success" }, ...muted(" | "), { text: clock(s.leftMs / 1000), tone }];
	return { tone, blocks: [{ kind: "bar", left: [...title, left], right: [muted("hit rate"), splitBar(r), hit], keepRight: true }] };
}

/** The `/cache` panel: a title bar, the details behind an expiring, cold or compacted meter, session totals, the latest requests. */
export function renderPanel(t: Tracker, s: Snapshot | undefined, env: Pick<Env, "model" | "warmingMode" | "host">): View {
	const { model, host } = env;
	let refresh = "no cache warmer";
	if (host.warmer) {
		refresh =
			s?.warming.scheduled && s.warming.nextWarmAt !== undefined
				? `auto-refresh in ${clock((s.warming.nextWarmAt - Date.now()) / 1000)} (~${usd(s.warming.refreshCost)})`
				: `warming ${env.warmingMode}`;
	}
	const about = [model ? `${model.provider} · ${model.id}` : undefined, s?.tierLabel, refresh, host.priceNote].filter(Boolean).join(" · ");
	const header: Block = { kind: "bar", left: [[{ text: "⛁ Cache · this session", tone: "strong" }]], right: [muted(about)] };
	if (!s) return { tone: "accent", blocks: [header, { kind: "gap" }, { kind: "bar", left: [muted("No requests yet.")], right: [] }] };
	const details: Block[] = [];
	const c = s.compacted;
	if (c?.tokensAfter !== undefined && c.perTurn !== undefined) {
		const sizes = `reads ${tokens(c.tokensAfter)} instead of ${tokens(c.tokensBefore)}`;
		const rows: Cell[][] = [[[{ text: "per turn", tone: "accent" }], [{ text: `~${usd(c.perTurn)} less`, tone: "success" }], muted(sizes)]];
		const r = c.result;
		if (r) {
			// A cost ledger, like the meter's `+$… now`: what the compaction paid, minus the rebuild it avoided.
			rows.push(
				[muted("summary request"), [{ text: usd(r.summary) }], muted("resends the conversation to summarise it, plus the summary")],
				[muted("next request"), [{ text: usd(r.after) }], muted(`writes the new ${tokens(c.tokensAfter)} prefix`)],
				[muted("rebuild avoided"), [{ text: `−${usd(r.avoided)}` }], muted(`the cache had expired: ${tokens(c.tokensBefore)} would have been written again`)],
				r.net >= 0
					? [[{ text: "now", tone: "accent" }], [{ text: `−${usd(r.net)}`, tone: "success" }], muted("paid for itself")]
					: [[{ text: "now", tone: "accent" }], [{ text: `+${usd(-r.net)}`, tone: "warning" }], muted("more than continuing; the cheaper turns repay it")],
			);
		}
		details.push({ kind: "table", cols: [{}, { align: "end" }, { grow: true, priority: -1 }], rows }, { kind: "gap" });
	} else if ((s.stage === "expiring" || s.stage === "cold") && s.warming.reason) {
		const rows: Cell[][] = [[muted(s.stage === "cold" ? "why it went cold" : "why it may expire"), [], muted(s.warming.reason)]];
		if (s.stage === "cold") {
			const head = s.headTokens > 0 ? ` (${tokens(s.headTokens)} of it still cached)` : "";
			rows.push([[{ text: "continue", tone: "accent" }], [{ text: `≈ ${usd(s.rewriteCost)}` }], muted(`rebuilds ${tokens(s.prefixTokens)}${head}`)]);
			const p = s.plan;
			if (p) {
				const payback = p.extra <= 0 ? "cheaper now" : Number.isFinite(p.paybackTurns) ? `pays back in ~${p.paybackTurns} turns` : "never pays back";
				rows.push(
					[[{ text: "/compact", tone: "accent" }], [{ text: `≈ ${usd(p.summaryCost + p.afterCost)}` }], muted(`summary ${usd(p.summaryCost)} + rewrite ${tokens(p.afterTokens)} ${usd(p.afterCost)} · ${payback}`)],
					[[], [], muted(`then every later rebuild ~${usd(p.laterRebuildSaving)} cheaper`)],
				);
			}
			rows.push([[{ text: host.freshCommand, tone: "accent" }], [], muted("fresh session; nothing to rebuild")]);
		}
		details.push({ kind: "table", cols: [{}, { align: "end" }, { grow: true, priority: -1 }], rows }, { kind: "gap" });
	}
	let read = 0;
	let all = 0;
	for (const r of t.history) {
		read += r.read;
		all += r.read + r.write + r.uncached;
	}
	const k = t.totals;
	const kpis: Block = {
		kind: "table",
		cols: [{ head: "session hit" }, { head: "saved by the cache" }, ...(host.warmer ? [{ head: "warming", priority: -2 }] : []), { head: "misses", priority: -1 }],
		rows: [
			[
				[{ text: `${all > 0 ? ((100 * read) / all).toFixed(1) : "0.0"}%`, tone: "success" }],
				[{ text: usd(k.saved) }],
				...(host.warmer ? [[{ text: usd(k.warmCost) }, ...muted(` · ${k.warms} ${k.warms === 1 ? "refresh" : "refreshes"}`)]] : []),
				[{ text: String(k.misses), tone: k.misses > 0 ? "warning" : undefined }, ...muted(` · ${usd(k.missCost)} rewrites`)],
			],
		],
	};
	const recent = t.history.slice(-8);
	let turn = t.history.filter(r => r.kind === "turn").length - recent.filter(r => r.kind === "turn").length;
	const rows: Cell[][] = recent.map((r, i) => {
		const total = r.read + r.write + r.uncached;
		const miss = !r.afterCompact && (i > 0 || t.history.length > recent.length) && r.read === 0 && r.write > 0;
		return [
			muted(new Date(r.at).toTimeString().slice(0, 8)),
			r.kind === "warm" ? [{ text: "warm", tone: "accent" }] : [{ text: `turn ${++turn}` }],
			splitBar(r),
			[{ text: tokens(r.read) }],
			[{ text: tokens(r.write) }],
			[{ text: tokens(r.uncached) }],
			[{ text: `${((100 * r.read) / total).toFixed(1)}%`, tone: r.read / total >= 0.9 ? undefined : "warning" }],
			[{ text: usd(r.cost) }],
			r.afterCompact ? [{ text: "after /compact", tone: "accent" }] : miss ? [{ text: "miss", tone: "error" }] : [],
		];
	});
	const end = { align: "end" } as const;
	const requests: Block = {
		kind: "table",
		cols: [{ head: "time" }, { head: "request" }, { head: "split", priority: -1 }, { head: "read", ...end }, { head: "write", ...end }, { head: "uncached", ...end, priority: -2 }, { head: "hit", ...end }, { head: "cost", ...end }, { head: "" }],
		rows,
	};
	const footer: Block = { kind: "bar", left: host.panelFooter.map(text => muted(text)), right: [] };
	return { tone: "accent", blocks: [header, { kind: "gap" }, ...details, kpis, { kind: "gap" }, requests, { kind: "gap" }, footer] };
}
