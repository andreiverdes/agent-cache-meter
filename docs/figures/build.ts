// Draws the README's two explanatory figures as light and dark SVGs: `bun docs/figures/build.ts`.
// The numbers come from a real omp session (Opus 5.5, 1-hour cache, list prices) that came back after 15 hours
// with a 487k-token context; prices and compaction sizes come from the packages' own tables.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pricing } from "../../claude-code/src/prices";
import { SUMMARY_TOKENS } from "../../claude-code/src/profile";

const rates = pricing("claude-opus-5-5")?.rates(0);
if (!rates) throw new Error("no prices for claude-opus-5-5");
const M = 1e6;

// The session: 37k shared head (system prompt and tools), 487k context when it came back.
const HEAD = 37_000;
const CONTEXT = 487_000;
/** A warm request in that session: reads the context, writes ~1.4k new tokens, ~600 tokens of output. */
const warmRequest = (context: number): number => (context * rates.read + 1_400 * rates.write1h + 600 * rates.output) / M;
/** The first request after the cache expired: the head is read, the rest written again at the 1-hour price. */
const rebuild = (context: number): number => (HEAD * rates.read + (context - HEAD) * rates.write1h + 900 * rates.output) / M;

// After /compact: the head, the summary, the kept or re-attached context.
const OMP_AFTER = HEAD + 3_000 + 20_000; // omp keeps the last 20k tokens verbatim
const CC_AFTER = HEAD + SUMMARY_TOKENS + 30_000; // Claude Code re-attaches files (measured 31-57k beyond the head)
/** omp's summary request on a cold cache writes the history to the cache again; Claude Code sends it as input. */
const ompCompact = ((CONTEXT - 20_000 - HEAD) * rates.write1h + HEAD * rates.read + 3_000 * rates.output) / M + rebuild(OMP_AFTER);
const ccCompact = ((CONTEXT - HEAD) * rates.input + HEAD * rates.read + SUMMARY_TOKENS * rates.output) / M + rebuild(CC_AFTER);

const usd = (n: number): string => `$${n.toFixed(2)}`;

interface Palette {
	text: string;
	muted: string;
	grid: string;
	cold: string;
	warm: string;
	omp: string;
	band: string;
}
const LIGHT: Palette = { text: "#1f2328", muted: "#59636e", grid: "#d1d9e0", cold: "#cf222e", warm: "#1a7f37", omp: "#0969da", band: "#dafbe1" };
const DARK: Palette = { text: "#e6edf3", muted: "#9198a1", grid: "#3d444d", cold: "#f85149", warm: "#3fb950", omp: "#4493f8", band: "#12261e" };
const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;

const text = (x: number, y: number, s: string, fill: string, extra = ""): string =>
	`<text x="${x}" y="${y}" fill="${fill}"${extra.includes("font-size") ? "" : ` font-size="13"`} ${extra}>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`;

/** Figure 1: what a request costs while the cache is warm, and the one after it expires. */
function timeline(p: Palette): string {
	const W = 900;
	const H = 300;
	const base = 230; // bar baseline
	const scale = 150 / rebuild(CONTEXT); // px per dollar: the rebuild is the tallest bar
	const out: string[] = [];
	const bar = (x: number, cost: number, fill: string) => `<rect x="${x}" y="${(base - cost * scale).toFixed(1)}" width="8" height="${Math.max(2, cost * scale).toFixed(1)}" rx="2" fill="${fill}"/>`;
	// Working: a request every few seconds, each reading the whole context.
	for (let i = 0; i < 14; i++) out.push(bar(40 + i * 14, warmRequest(CONTEXT + i * 1500), p.warm));
	const lastX = 40 + 13 * 14 + 8;
	// The hour the cache stays warm after the last request.
	out.push(`<rect x="${lastX}" y="${base - 160}" width="240" height="160" fill="${p.band}"/>`);
	out.push(text(lastX + 10, base - 140, "cache warm for 1 h", p.warm, `font-weight="600"`));
	out.push(text(lastX + 10, base - 122, "after the last request", p.muted));
	out.push(text(lastX + 10, base - 92, "the meter counts this down", p.muted));
	out.push(text(lastX + 10, base - 74, "and says what the rebuild", p.muted));
	out.push(text(lastX + 10, base - 56, `will cost: ${usd(rebuild(CONTEXT))}`, p.muted));
	// Expired.
	const coldX = lastX + 240;
	out.push(`<line x1="${coldX}" y1="${base - 165}" x2="${coldX}" y2="${base}" stroke="${p.cold}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
	out.push(text(coldX + 8, base - 150, "expired", p.cold, `font-weight="600"`));
	out.push(text(coldX + 70, base + 34, "… 15 hours later …", p.muted, `font-style="italic"`));
	// Coming back: the rebuild, then warm requests again.
	const backX = 690;
	out.push(bar(backX, rebuild(CONTEXT), p.cold));
	for (let i = 1; i < 12; i++) out.push(bar(backX + i * 14, warmRequest(CONTEXT + i * 1500), p.warm));
	out.push(text(backX - 150, base - 130, `first request back: ${usd(rebuild(CONTEXT))}`, p.cold, `font-weight="600"`));
	out.push(text(backX - 150, base - 112, `rewrites ${Math.round((CONTEXT - HEAD) / 1000)}k tokens`, p.muted));
	out.push(text(backX - 150, base - 94, `= ${Math.round(rebuild(CONTEXT) / warmRequest(CONTEXT))} warm requests`, p.muted));
	// Axis and the warm request's price.
	out.push(`<line x1="30" y1="${base}" x2="${W - 20}" y2="${base}" stroke="${p.grid}"/>`);
	out.push(text(40, base + 22, `each request ≈ ${usd(warmRequest(CONTEXT))}: it reads all ${Math.round(CONTEXT / 1000)}k tokens from the cache`, p.warm));
	out.push(text(40, base + 52, `Opus 5.5 at list prices, a ${Math.round(CONTEXT / 1000)}k-token conversation; bar height = cost of one request.`, p.muted, `font-size="12"`));
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>${out.join("")}</svg>`;
}

/** Figure 2: total spend over the requests after coming back, continuing vs compacting first. */
function cumulative(p: Palette): string {
	const W = 900;
	const H = 360;
	const L = 60;
	const R = 230; // room for line labels
	const T = 20;
	const B = 300;
	const N = 40;
	const series = [
		{ name: "continue", sub: `${Math.round(CONTEXT / 1000)}k context`, color: p.cold, dash: "", first: rebuild(CONTEXT), size: CONTEXT },
		{ name: "/compact first · omp", sub: `${Math.round(OMP_AFTER / 1000)}k context`, color: p.omp, dash: `stroke-dasharray="6 4"`, first: ompCompact, size: OMP_AFTER },
		{ name: "/compact first · Claude Code", sub: `${Math.round(CC_AFTER / 1000)}k context`, color: p.warm, dash: "", first: ccCompact, size: CC_AFTER },
	];
	const total = (s: (typeof series)[number], n: number): number => {
		let sum = s.first;
		for (let i = 1; i < n; i++) sum += warmRequest(s.size + i * 1400);
		return sum;
	};
	const ymax = Math.ceil(Math.max(...series.map(s => total(s, N))));
	const x = (n: number) => L + ((W - L - R) * n) / N;
	const y = (d: number) => B - ((B - T) * d) / ymax;
	const out: string[] = [];
	for (let d = 0; d <= ymax; d += 2) {
		out.push(`<line x1="${L}" y1="${y(d)}" x2="${W - R}" y2="${y(d)}" stroke="${p.grid}"/>`);
		out.push(text(L - 10, y(d) + 4, `$${d}`, p.muted, `text-anchor="end"`));
	}
	for (let n = 0; n <= N; n += 10) out.push(text(x(n), B + 20, String(n), p.muted, `text-anchor="middle"`));
	out.push(text((L + W - R) / 2, B + 44, "requests after coming back (one message with tool calls is often 10–30)", p.muted, `text-anchor="middle"`));
	for (const s of series) {
		const pts = [`${x(0)},${y(0)}`];
		for (let n = 1; n <= N; n++) pts.push(`${x(n).toFixed(1)},${y(total(s, n)).toFixed(1)}`);
		out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.5" ${s.dash}/>`);
		const end = total(s, N);
		out.push(text(x(N) + 10, y(end) - 2, `${s.name}  ${usd(end)}`, s.color, `font-weight="600"`));
		out.push(text(x(N) + 10, y(end) + 14, `${usd(s.first)} up front, then ${usd(warmRequest(s.size))}/request`, p.muted, `font-size="12"`));
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>${out.join("")}</svg>`;
}

// SVG sources plus 2× PNGs: raw.githubusercontent.com serves SVG as text, so the README (also npm's page) uses PNGs.
const dir = path.dirname(new URL(import.meta.url).pathname);
for (const [name, draw] of [["cache-timeline", timeline], ["cache-cost", cumulative]] as const) {
	for (const [suffix, palette] of [["", LIGHT], ["-dark", DARK]] as const) {
		const svg = path.join(dir, `${name}${suffix}.svg`);
		fs.writeFileSync(svg, draw(palette));
		execFileSync("rsvg-convert", ["-z", "2", svg, "-o", svg.replace(/\.svg$/, ".png")]);
	}
}
