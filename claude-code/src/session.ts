import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model, Usage } from "../../omp-extension/host";
import { Tracker } from "../../omp-extension/meter";
import { pricing } from "./prices";
import { REATTACHED_TOKENS, SUMMARY_TOKENS } from "./profile";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const STATE_DIR = path.join(CLAUDE_DIR, "cache-meter", "sessions");

/** Follows `keys` through nested objects; undefined as soon as one is missing. */
export function dig(o: unknown, ...keys: string[]): unknown {
	let v = o;
	for (const k of keys) v = typeof v === "object" && v !== null ? Reflect.get(v, k) : undefined;
	return v;
}
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The fields of Claude Code's status line JSON the meter uses. */
export interface StatusInput {
	sessionId: string;
	transcriptPath: string;
	cwd: string;
	modelId: string;
	/** The main conversation's cache lifetime (`prompt_cache.ttl`), when Claude Code reports one. */
	ttl: "5m" | "1h" | undefined;
	/** False once Claude Code has seen responses but none reported cache tokens. */
	cachingOff: boolean;
	/** Claude subscriptions report `rate_limits`; usage within the plan is not billed per token. */
	subscription: boolean;
}

export function parseInput(raw: unknown): StatusInput | undefined {
	const sessionId = str(dig(raw, "session_id"));
	const transcriptPath = str(dig(raw, "transcript_path"));
	if (!sessionId || !transcriptPath) return undefined;
	const ttl = dig(raw, "prompt_cache", "ttl");
	const requests = count(dig(raw, "prompt_cache", "requests"));
	return {
		sessionId,
		transcriptPath,
		cwd: str(dig(raw, "workspace", "current_dir")) ?? str(dig(raw, "cwd")) ?? process.cwd(),
		modelId: str(dig(raw, "model", "id")) ?? "",
		ttl: ttl === "5m" || ttl === "1h" ? ttl : undefined,
		cachingOff: requests > 0 && dig(raw, "prompt_cache", "caching_observed") === false,
		subscription: typeof dig(raw, "rate_limits") === "object" && dig(raw, "rate_limits") !== null,
	};
}

/** The meter's view of a Claude model: its rates for a prompt of this size, 5- and 60-minute cache lifetimes. */
export function modelFor(id: string, promptTokens: number): Model | undefined {
	const p = pricing(id);
	if (!p) return undefined;
	const rates = p.rates(promptTokens);
	// Contracted rates have one cache-write rate for both lifetimes; only list prices get the meter's 1h factor,
	// which it applies to `anthropic-messages` models.
	return {
		id,
		provider: "anthropic",
		api: p.contracted ? "anthropic-contracted" : "anthropic-messages",
		cost: { input: rates.input, output: rates.output, cacheRead: rates.read, cacheWrite: rates.write5m },
		promptCache: { short: 300, long: 3600 },
	};
}

/** One assistant message's usage in the meter's shape, priced at its own model's rates. */
function usageOf(u: unknown, modelId: string): Usage {
	const input = count(dig(u, "input_tokens"));
	const output = count(dig(u, "output_tokens"));
	const cacheRead = count(dig(u, "cache_read_input_tokens"));
	const cacheWrite = count(dig(u, "cache_creation_input_tokens"));
	const w1h = Math.min(count(dig(u, "cache_creation", "ephemeral_1h_input_tokens")), cacheWrite);
	const w5m = cacheWrite - w1h;
	const rates = pricing(modelId)?.rates(input + cacheRead + cacheWrite);
	const total = rates ? (input * rates.input + output * rates.output + cacheRead * rates.read + w5m * rates.write5m + w1h * rates.write1h) / 1e6 : 0;
	return { input, output, cacheRead, cacheWrite, cost: { total }, cttl: cacheWrite > 0 ? { ephemeral5m: w5m, ephemeral1h: w1h } : undefined };
}

interface Saved {
	v: 1;
	transcript: string;
	/** Bytes of the transcript already read: always the end of a complete line. */
	offset: number;
	/** Message ids recorded last: Claude Code writes one entry per content block, all with the same usage. */
	recent: string[];
	/** The model of the last main-conversation response. */
	model: string | undefined;
	tracker: Pick<Tracker, "history" | "totals" | "observedTier" | "requestedTier" | "compacted">;
	/** The Tern pane body last written, so an unchanged state isn't rewritten every second. */
	published: string;
}

/** A session's Tracker, caught up with its transcript, and what to save back. */
export interface Session {
	tracker: Tracker;
	/** The model id Claude Code reports, else the last response's. */
	model: string | undefined;
	published: string;
	save(published: string): void;
}

/** Loads the session's saved Tracker and reads only the transcript lines appended since the last run. */
export function loadSession(input: StatusInput): Session {
	const file = path.join(STATE_DIR, `${input.sessionId}.json`);
	let saved: Saved | undefined;
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		const ours = dig(raw, "v") === 1 && dig(raw, "transcript") === input.transcriptPath && typeof dig(raw, "offset") === "number" && Array.isArray(dig(raw, "tracker", "history"));
		if (ours) saved = raw as Saved; // checked above: this script's own file, same version and transcript
	} catch {
		saved = undefined;
	}
	const tracker = Object.assign(new Tracker(), saved?.tracker);
	const start = saved?.offset ?? 0;
	let offset = start;
	const seen = { recent: saved?.recent ?? [], model: saved?.model };

	let fd: number | undefined;
	try {
		fd = fs.openSync(input.transcriptPath, "r");
		const size = fs.fstatSync(fd).size;
		if (size < offset) {
			// The transcript was rewritten: start over.
			tracker.reset();
			offset = 0;
			seen.recent = [];
		}
		if (size > offset) {
			const buf = Buffer.alloc(size - offset);
			fs.readSync(fd, buf, 0, buf.length, offset);
			const end = buf.lastIndexOf(0x0a) + 1; // a line still being written waits for the next run
			for (const line of buf.subarray(0, end).toString("utf8").split("\n")) read(line, tracker, seen);
			offset += end;
		}
	} catch {
		// No transcript yet: the meter shows nothing until the first response lands.
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	const tierBefore = tracker.requestedTier;
	if (input.ttl) tracker.requestedTier = input.ttl === "1h" ? "long" : "short";
	const changed = !saved || offset !== start || tracker.requestedTier !== tierBefore;

	return {
		tracker,
		model: input.modelId || seen.model,
		published: saved?.published ?? "",
		save(published) {
			if (!changed && published === saved?.published) return;
			const body: Saved = {
				v: 1,
				transcript: input.transcriptPath,
				offset,
				recent: seen.recent.slice(-8),
				model: seen.model,
				tracker: { history: tracker.history, totals: tracker.totals, observedTier: tracker.observedTier, requestedTier: tracker.requestedTier, compacted: tracker.compacted },
				published,
			};
			fs.mkdirSync(STATE_DIR, { recursive: true });
			fs.writeFileSync(`${file}.tmp`, JSON.stringify(body)); // tmp + rename: a cancelled run never leaves half a file
			fs.renameSync(`${file}.tmp`, file);
		},
	};
}

/** Applies one transcript line: a main-conversation response, a compaction, or the summary that follows it. */
function read(line: string, tracker: Tracker, seen: { recent: string[]; model: string | undefined }): void {
	// Most lines are tool output and attachments; skip them before paying for JSON.parse.
	if (!line.includes('"assistant"') && !line.includes("compact_boundary") && !line.includes("isCompactSummary")) return;
	let e: unknown;
	try {
		e = JSON.parse(line);
	} catch {
		return;
	}
	if (dig(e, "isSidechain") === true) return;
	const at = Date.parse(str(dig(e, "timestamp")) ?? "") || Date.now();
	const type = dig(e, "type");
	if (type === "assistant") {
		const id = str(dig(e, "message", "id"));
		const modelId = str(dig(e, "message", "model")) ?? "";
		const u = dig(e, "message", "usage");
		if (!id || seen.recent.includes(id) || modelId === "<synthetic>" || typeof u !== "object" || u === null) return;
		seen.recent.push(id);
		if (seen.recent.length > 8) seen.recent.shift();
		seen.model = modelId;
		const usage = usageOf(u, modelId);
		tracker.record("turn", usage, at, modelFor(modelId, usage.input + usage.cacheRead + usage.cacheWrite));
	} else if (type === "system" && dig(e, "subtype") === "compact_boundary") {
		const before = count(dig(e, "compactMetadata", "preTokens"));
		const post = count(dig(e, "compactMetadata", "postTokens"));
		// `postTokens` leaves out the system prompt and tools (the session's first read) and the files Claude Code
		// attaches again; the next request sends all three. The summary request itself sends the whole conversation.
		const head = tracker.history[0]?.read ?? 0;
		const after = post > 0 ? head + post + REATTACHED_TOKENS : undefined;
		tracker.compacted = { at, tokensBefore: before, tokensAfter: after, summaryTokens: SUMMARY_TOKENS, usedTokens: before };
	} else if (type === "user" && dig(e, "isCompactSummary") === true && tracker.compacted) {
		const content = dig(e, "message", "content");
		const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
		// The summary's own length; thinking comes on top, so the measured output is the floor.
		tracker.compacted.summaryTokens = Math.max(SUMMARY_TOKENS, Math.round(text.length / 4));
	}
}
