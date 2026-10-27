# claude-cache-meter

A prompt-cache meter for [Claude Code](https://code.claude.com)'s status line. It shows how many tokens the last request read from the cache, wrote to it and sent uncached, and counts down to the cache's expiry. When the cache goes cold it says what rebuilding it costs and what `/compact` costs instead; after `/compact` it shows what each later turn saves.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/andreiverdes/agent-cache-meter/main/docs/screenshots/claude-statusline-light.png">
  <img alt="Claude Code's status line under the prompt: 'cache' with a green 'warm', read 37.8k · write 0 · uncached 2, then at the right end 'hit rate', the split bar, 100.0% | 60:00" src="https://raw.githubusercontent.com/andreiverdes/agent-cache-meter/main/docs/screenshots/claude-statusline.png">
</picture>

It is the [agent-cache-meter](https://github.com/andreiverdes/agent-cache-meter) meter, the same code omp's `omp-cache-meter` extension runs, for Claude Code.

## Install

Needs Node.js 18 or later and Claude Code 2.1.251 or later.

```sh
npx claude-cache-meter install
```

`install` installs the package globally and sets `statusLine` in `~/.claude/settings.json` (the old file is kept as `settings.json.bak`). If you already have a status line it stops and changes nothing. Claude Code picks the new status line up right away; the meter appears after the next response.

Or as a Claude Code plugin, which runs the same command for you:

```text
/plugin install cache-meter --marketplace andreiverdes/agent-cache-meter
/cache-meter:setup
```

To remove it: `claude-cache-meter uninstall`, then `npm uninstall -g claude-cache-meter`.

## The meter

One line while the cache is warm, expiring or just compacted, two when it's cold:

| State | Left | Right end |
|---|---|---|
| Warm | `read · write · uncached` of the last request | `hit rate`, split bar, `99.6% \| 59:12` |
| Expires soon | `rebuild cost 96.6k ≈ $0.39 after` | the same, the countdown in amber |
| Cold | `rebuild cost 365.5k ≈ $2.81`; line 2: `/compact recommended · ≈ $1.74 · save ~$1.07`, or `continue recommended · /compact wouldn't make it smaller` for a short conversation | `1h · expired \| 4:00 ago`; `list price` on a subscription |
| Reset by `/compact` | `~$0.09 less per turn · paid for itself (~$0.74) · next ≈ $0.21` | `518.2k → 62.5k` |

On a Claude subscription the dollar amounts end in `· list price`: they compare options at API prices, they aren't a bill.

### Why `/compact` on a cold cache

When the cache has expired, your next message writes the whole conversation to the cache again, at 1.25× the input price (5-minute cache) or 2× (1-hour cache). `/compact` sends the conversation to the summary request as plain input (1×) instead, and the next request writes only the much smaller summary. So on a cold cache the meter always recommends `/compact`, and shows what it costs next to what continuing costs.

After `/compact` the meter keeps two amounts apart. **Per turn** is what every later request saves by reading the smaller context from the cache. **Now** is the compaction's one-off result, shown when the cache had already expired: the rebuild it avoided minus the summary request and the first write of the new context.

## `claude-cache-meter panel`

Run it in a project directory for that directory's newest session: session totals, the last eight requests with their split, and on a cold or compacted cache the breakdown behind the meter. Claude Code has no command that shows output without spending a turn, so the panel lives in the terminal.

## Settings

`~/.claude/cache-meter.json`, all optional:

| Setting | Default | Meaning |
|---|---|---|
| `meter.show` | `always` | `near-expiry` shows the meter only when the cache is about to expire or has; `off` hides it |
| `meter.warnLeadSeconds` | `60` | How long before expiry the meter turns amber |
| `tern.publish` | `auto` | In a [Tern](https://github.com/andreiverdes/agent-cache-meter#the-tern-plugin) pane, write the state Tern's cache-meter plugin reads; `off` never writes it |

## How it works

- **Input:** Claude Code runs the status line on each response, after `/compact` and once a second (`refreshInterval: 1`), with the session JSON on stdin. The meter reads the cache lifetime from `prompt_cache.ttl` and the model from `model.id`.
- **History:** it reads the session transcript once, then only the lines added since the last run, and keeps the result in `~/.claude/cache-meter/sessions/`. A run takes about 45 ms on a 52 MB transcript.
- **Prices:** list prices per model from the catalog Claude Code 2.1.302 ships, including Haiku 5.5's long-prompt rates. An organisation's `modelPricing` in `managed-settings.json` replaces them. A model the table doesn't know shows tokens without dollars.
- **Compaction:** measured on Claude Code 2.1.302. The summary request sends the whole conversation, the system prompt and tools read from the cache, the rest as input. The first request after it sends the system prompt and tools, the transcript's `postTokens`, and about 20k tokens of files Claude Code attaches again.

## Limitations

- **Prices are estimates:** the table may lag Anthropic's prices for new models, and fast mode and US-only inference surcharges aren't included.
- **Compaction sizes are estimates** until the first request after it lands.
- **Subagents aren't counted:** like Claude Code's own `prompt_cache` statistics, the meter covers the main conversation.

## License

[MIT](https://github.com/andreiverdes/agent-cache-meter/blob/main/LICENSE)
