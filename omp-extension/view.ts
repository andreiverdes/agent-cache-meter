// A small layout model for the meter and the /cache panel, and its two painters: toAnsi pads it into aligned
// terminal lines with the omp theme; toTsp describes it as native nodes (rows, spacers, badges, tables) for
// hosts such as Tern, which lay it out and paint it with their own theme.
import type { Theme } from "./host";

export type Tone = "success" | "warning" | "error" | "accent" | "muted" | "strong";

export interface Span {
	text: string;
	tone?: Tone;
}
/** One item of a bar: spans kept together, a badge (a chip natively, toned text in a terminal), or a thin stacked bar. */
export type Item = Span[] | { badge: string; tone: Tone } | { bar: [number, Tone][] };
/** A table cell: text, or a thin stacked bar of [fraction, tone] parts. */
export type Cell = Span[] | { bar: [number, Tone][] };

export interface Column {
	/** Header text; a table with no heads has no header row. */
	head?: string;
	align?: "start" | "end";
	/** Takes the spare width and is cut first when the table is too wide. */
	grow?: boolean;
	/** Columns with the lowest priority hide first when narrow (default 0). */
	priority?: number;
}

export type Block =
	/** `left` items from the left edge, `right` items flush right. `keepRight`: in a narrow terminal the outermost right
	 * item (a countdown) outlasts the end of the left text; otherwise the right items give way first. */
	| { kind: "bar"; left: Item[]; right: Item[]; keepRight?: boolean }
	| { kind: "table"; cols: Column[]; rows: Cell[][] }
	| { kind: "gap" };

export interface View {
	/** The edge colour: the meter's stage, or accent for the panel. */
	tone: Tone;
	blocks: Block[];
}

const GAP = 3; // columns between items and between table columns in a terminal
const BAR_CELLS = 12; // width of a bar cell in a terminal
const MIN_PART = 0.02; // thinnest native meter part kept: under 2 px on a 90 px bar, below Tern's cap radius
const MIN_CUT = 8; // fewest columns of a cut text worth keeping

const isBar = (c: Cell | Item): c is { bar: [number, Tone][] } => !Array.isArray(c) && "bar" in c;
const spansText = (spans: Span[]): string => spans.map(s => s.text).join("");

// ── terminal ───────────────────────────────────────────────────────────────

function paintSpans(spans: Span[], theme: Theme): string {
	return spans.map(s => (s.tone && s.tone !== "strong" ? theme.fg(s.tone, s.text) : s.text)).join("");
}

function paintItem(it: Item, theme: Theme): string {
	if (Array.isArray(it)) return paintSpans(it, theme);
	return isBar(it) ? barGlyphs(it.bar, theme) : theme.fg(it.tone === "strong" ? "accent" : it.tone, it.badge);
}

/** Cuts spans to `width` columns, ending in `…` when anything was cut. */
function clip(spans: Span[], width: number): Span[] {
	if (spansText(spans).length <= width) return spans;
	const out: Span[] = [];
	let left = Math.max(0, width - 1);
	for (const s of spans) {
		if (left <= 0) break;
		out.push({ ...s, text: s.text.slice(0, left) });
		left -= s.text.length;
	}
	out.push({ text: "…", tone: "muted" });
	return out;
}

function barGlyphs(parts: [number, Tone][], theme: Theme): string {
	let out = "";
	let used = 0;
	for (const [frac, tone] of parts) {
		const n = Math.min(BAR_CELLS - used, Math.round(frac * BAR_CELLS));
		if (n > 0) out += theme.fg(tone === "strong" ? "accent" : tone, "━".repeat(n));
		used += Math.max(0, n);
	}
	return BAR_CELLS > used ? out + theme.fg("muted", "─".repeat(BAR_CELLS - used)) : out;
}

/**
 * Left items, then right items flush right. When they don't fit, right items drop from their inner end. With
 * `keepRight` the outermost one stays while cutting the last left text makes room; then the last left text is cut,
 * then left items drop.
 */
function paintBar(left: Item[], right: Item[], keepRight: boolean, theme: Theme, width: number): string {
	const widthOf = (items: Item[]) =>
		items.reduce((n, it, i) => n + (Array.isArray(it) ? spansText(it).length : isBar(it) ? BAR_CELLS : it.badge.length) + (i > 0 ? GAP : 0), 0);
	const l = [...left];
	const r = [...right];
	while (r.length > (keepRight ? 1 : 0) && widthOf(l) + GAP + widthOf(r) > width) r.shift();
	// Fits the left items into `avail`: the last text is cut while at least MIN_CUT columns of it stay, else dropped.
	const fitLeft = (avail: number): boolean => {
		while (widthOf(l) > avail) {
			const last = l[l.length - 1];
			const room = avail - widthOf(l.slice(0, -1)) - (l.length > 1 ? GAP : 0);
			if (Array.isArray(last) && (room >= MIN_CUT || l.length === 1)) l[l.length - 1] = clip(last, Math.max(1, room));
			else if (l.length > 1) l.pop();
			else return false;
		}
		return true;
	};
	// The kept right item stays only if the left side just gets cut; when left items would have to go, it goes.
	if (r.length > 0 && widthOf(l) + GAP + widthOf(r) > width) {
		const kept = [...l];
		if (!fitLeft(width - GAP - widthOf(r)) || l.length < kept.length) {
			l.splice(0, l.length, ...kept);
			r.length = 0;
		}
	}
	fitLeft(width);
	const pad = " ".repeat(GAP);
	let out = l.map(it => paintItem(it, theme)).join(pad);
	if (r.length > 0) out += " ".repeat(width - widthOf(l) - widthOf(r)) + r.map(it => paintItem(it, theme)).join(pad);
	return out;
}

/** Columns sized to their widest cell; when too wide, low-priority columns hide, then the grow column is cut. */
function paintTable(cols: Column[], rows: Cell[][], theme: Theme, width: number): string[] {
	const heads = cols.some(c => c.head);
	const widths = cols.map((c, i) =>
		Math.max(heads ? (c.head ?? "").length : 0, ...rows.map(r => (r[i] === undefined ? 0 : isBar(r[i]) ? BAR_CELLS : spansText(r[i]).length))),
	);
	const shown = cols.map((_, i) => i);
	const total = () => shown.reduce((n, i, k) => n + widths[i] + (k > 0 ? GAP : 0), 0);
	const byPriority = [...shown].sort((a, b) => (cols[a].priority ?? 0) - (cols[b].priority ?? 0));
	for (const i of byPriority) {
		if (total() <= width || (cols[i].priority ?? 0) >= 0) break;
		shown.splice(shown.indexOf(i), 1);
	}
	const grow = shown.find(i => cols[i].grow);
	if (grow !== undefined && total() > width) widths[grow] = Math.max(4, widths[grow] - (total() - width));

	const line = (cells: (i: number) => { text: string; painted: string }): string =>
		shown
			.map((i, k) => {
				const { text, painted } = cells(i);
				const pad = " ".repeat(Math.max(0, widths[i] - text.length));
				const last = k === shown.length - 1;
				return cols[i].align === "end" ? pad + painted : last ? painted : painted + pad;
			})
			.join(" ".repeat(GAP))
			.replace(/ +$/, ""); // an empty last column leaves only padding
	const out: string[] = [];
	if (heads) {
		out.push(line(i => {
			const h = (cols[i].head ?? "").slice(0, widths[i]);
			return { text: h, painted: theme.fg("muted", h) };
		}));
	}
	for (const row of rows) {
		out.push(line(i => {
			const c = row[i] ?? [];
			if (isBar(c)) return { text: "".padEnd(BAR_CELLS), painted: barGlyphs(c.bar, theme) };
			const cut = clip(c, widths[i]);
			return { text: spansText(cut), painted: paintSpans(cut, theme) };
		}));
	}
	return out;
}

/** Terminal lines: an edge mark and a space before each, and a blank row after so it doesn't touch the composer. */
export function toAnsi(view: View, theme: Theme, width: number): string[] {
	if (view.blocks.length === 0) return [];
	const edge = `${theme.fg(view.tone === "strong" ? "accent" : view.tone, "▌")} `;
	const inner = Math.max(10, width - 2);
	const out: string[] = [];
	for (const b of view.blocks) {
		if (b.kind === "gap") out.push(edge);
		else if (b.kind === "bar") out.push(edge + paintBar(b.left, b.right, b.keepRight ?? false, theme, inner));
		else for (const l of paintTable(b.cols, b.rows, theme, inner)) out.push(edge + l);
	}
	return [...out, ""];
}

// ── native (TSP) ───────────────────────────────────────────────────────────

/**
 * Meter parts for a native host. Tern rounds only the outer ends of the first and last part, so a part too thin to
 * see (14 uncached tokens next to 96k read) would carry the cap and leave the visible end square: such parts go.
 */
function meterParts(bar: [number, Tone][]): { value: number; token: Tone }[] {
	return bar.filter(([value]) => value >= MIN_PART).map(([value, token]) => ({ value, token }));
}

const tspSpans = (spans: Span[]): unknown[] => spans.map(s => (s.tone ? { t: s.text, s: s.tone } : { t: s.text }));

/** A table cell for an item: badges, which cells can't hold, become toned text. */
function tspCell(it: Item | Cell): unknown {
	if (Array.isArray(it)) return tspSpans(it);
	if (isBar(it)) return { meter: { parts: meterParts(it.bar) } };
	return [{ t: it.badge, s: it.tone }];
}

/** A row child for an item. Meters get `grow: 0`: by default Tern stretches them over the row's spare width. */
function tspItem(it: Item, key: string): unknown {
	if (Array.isArray(it)) return { k: "text", p: { spans: tspSpans(it) }, key };
	if (isBar(it)) {
		const parts = meterParts(it.bar);
		return { k: "meter", p: { value: parts.reduce((n, p) => n + p.value, 0), style: "bar", size: "sm", grow: 0, parts }, key };
	}
	return { k: "badge", p: { text: it.badge, tone: it.tone }, key };
}

/**
 * A bar natively: the leading left items (title, badge) in a row, then one headless single-row table holding the
 * last left item and the right items. Rows only wrap when they overflow, which pushed the countdown onto its own
 * line; a table instead cuts its grow column and hides low-priority columns. The last left item grows and is cut;
 * right items hide from the inner end, and with `keepRight` the outermost one outlasts the left text.
 */
function tspBar(b: Extract<Block, { kind: "bar" }>, key: string): unknown {
	const lead = b.left.slice(0, -1);
	const last = b.left.at(-1);
	const cells: [Item, { align: "start" | "end"; grow: number; priority: number }][] = [];
	if (last) cells.push([last, { align: "start", grow: 1, priority: 0 }]);
	b.right.forEach((it, i) => {
		const outer = i === b.right.length - 1;
		cells.push([it, { align: outer ? "end" : "start", grow: 0, priority: outer && b.keepRight ? 1 : i - b.right.length }]);
	});
	const table = {
		k: "table",
		p: {
			grow: 1,
			cols: cells.map(([, c], i) => ({ id: `c${i}`, ...c, truncate: "end" })),
			rows: [{ id: "r0", cells: Object.fromEntries(cells.map(([it], i) => [`c${i}`, tspCell(it)])) }],
		},
		key: "t",
	};
	return { k: "row", p: { gap: "md", align: "center" }, c: [...lead.map((it, i) => tspItem(it, `l${i}`)), table], key };
}

function tspBlock(b: Block, key: string): unknown {
	if (b.kind === "gap") return { k: "spacer", p: { size: "sm" }, key };
	if (b.kind === "bar") return tspBar(b, key);
	return {
		k: "table",
		p: {
			cols: b.cols.map((c, i) => ({
				id: `c${i}`,
				// A head on any column turns on the header row; a headless table sends none.
				...(c.head !== undefined ? { head: c.head } : {}),
				align: c.align ?? "start",
				grow: c.grow ? 1 : 0,
				priority: c.priority ?? 0,
				truncate: "end",
			})),
			rows: b.rows.map((row, r) => ({
				id: `r${r}`,
				cells: Object.fromEntries(
					row.map((c, i) => [
						`c${i}`,
						tspCell(c),
					]),
				),
			})),
		},
		key,
	};
}

/** A native-surface node for the view (the `{k, p, c, key}` wire format omp's describe() uses). */
export function toTsp(view: View, role: string): unknown {
	return {
		k: "col",
		p: { role, gap: "xs", tone: view.tone === "strong" ? "accent" : view.tone },
		c: [...view.blocks.map((b, i) => tspBlock(b, `b${i}`)), { k: "spacer", p: { size: "md" }, key: "pad" }],
	};
}
