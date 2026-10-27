import type { HostProfile } from "../../omp-extension/meter";

// How Claude Code differs from omp for the meter. It has no cache warmer. A compaction's summary request repeats the
// system prompt, tools and the whole history; on an expired cache it sends the history as uncached input instead of
// writing it to the cache (docs: code.claude.com/docs/en/prompt-caching, "Compacting the conversation"), so /compact
// on a cold cache costs about the same as continuing and every later turn is cheaper: the meter always recommends it.
//
// Measured with Claude Code 2.1.302 on a 64.8k-token Haiku 5.5 session compacted 5.5 min after its last request:
// the summary request sent 52.9k tokens as input, read 11.4k (the system prompt and tools) and wrote 2.6k, with 3.2k
// tokens of output (a 5.7k-character summary plus thinking). The first request after it sent 45.3k tokens, though the
// transcript's `postTokens` said 11.3k; two 967k-token sessions show the same gap (30.8k → 68.0k, 32.3k → 71.3k).

/** The summary request's output: the summary plus thinking, 3.2k tokens in the measured compaction. */
export const SUMMARY_TOKENS = 3200;

/**
 * What the first request after a compaction sends beyond the system prompt and tools and `postTokens`: files and
 * state Claude Code attaches again. Measured 20.1k, 21.2k and 24.6k.
 */
export const REATTACHED_TOKENS = 20_000;

export function claudeHost(priceNote: string | undefined): HostProfile {
	return {
		warmer: false,
		summaryBilledAs: "input",
		coldAdvice: "always",
		// The summary request covers the whole conversation; nothing is kept out of it.
		keepRecentTokens: 0,
		summaryTokens: SUMMARY_TOKENS,
		// The context after a compaction beyond the system prompt and tools: 31.4k, 52.0k and 56.9k in the sessions above.
		extraAfterTokens: 30_000,
		// The status line has no room to spare; `claude-cache-meter panel` is in the README and the panel's footer.
		detailsHint: "",
		freshCommand: "/clear",
		cachingOffHint: "no prompt caching reported",
		priceNote,
		panelFooter: ["/compact", "/clear", "claude-cache-meter panel"],
	};
}
