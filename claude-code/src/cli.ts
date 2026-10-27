#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Env } from "../../omp-extension/meter";
import { renderMeter, renderPanel, snapshot } from "../../omp-extension/meter";
import { loadSettings } from "../../omp-extension/settings";
import { PANE_FILE, paneState, writePaneState } from "../../omp-extension/tern";
import { toAnsi } from "../../omp-extension/view";
import type { Theme } from "../../omp-extension/host";
import { pricing } from "./prices";
import { claudeHost } from "./profile";
import { CLAUDE_DIR, dig, loadSession, modelFor, parseInput, type StatusInput } from "./session";

const VERSION = "0.1.0";
const NAME = "claude-cache-meter";
const SETTINGS_FILE = path.join(CLAUDE_DIR, "cache-meter.json");
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, "settings.json");

// The terminal's 16 named colours, so the meter follows the terminal's own theme.
const SGR = { success: "32", warning: "33", error: "31", accent: "36", muted: "2", borderMuted: "2", text: "39" } as const;
const ANSI: Theme = { fg: (token, text) => `\x1b[${SGR[token]}m${text}\x1b[0m` };

function env(input: Pick<StatusInput, "modelId" | "subscription" | "cachingOff">, lastPrompt: number): Env {
	const p = pricing(input.modelId);
	// Dollars on a subscription are a comparison at API prices, not a bill; contracted rates are the bill.
	const note = p && !p.contracted && input.subscription ? "list price" : undefined;
	return {
		now: Date.now(),
		settings: loadSettings(SETTINGS_FILE),
		model: modelFor(input.modelId, lastPrompt),
		retention: input.cachingOff ? "none" : "auto",
		warmingMode: "off",
		agentRunning: false,
		host: claudeHost(note),
	};
}

/** The status line: Claude Code pipes the session JSON in and shows what this prints. */
function statusLine(raw: string): void {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return;
	}
	const input = parseInput(json);
	if (!input) return;
	const session = loadSession(input);
	const last = session.tracker.history.at(-1);
	const e = env(input, last ? last.read + last.write + last.uncached : 0);
	const s = snapshot(session.tracker, e);
	let published = session.published;
	if (s) {
		// Claude Code sets COLUMNS to the terminal width; its status row is indented by 2 on each side.
		const width = Math.max(40, Number(process.env.COLUMNS) || 100) - 4;
		const lines = toAnsi(renderMeter(s, e), ANSI, width).filter(l => l !== "");
		process.stdout.write(lines.join("\n"));
		if (PANE_FILE && e.settings.tern.publish === "auto") {
			const body = paneState(s, session.tracker, { host: "claude", label: path.basename(input.cwd), model: input.modelId ? `anthropic/${input.modelId}` : undefined, warnLeadSeconds: e.settings.meter.warnLeadSeconds });
			if (body !== published) writePaneState(body);
			published = body;
		}
	}
	session.save(published);
}

/** `panel`: the newest session in this directory, in the terminal. */
function panel(): void {
	const dir = path.join(CLAUDE_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
	let newest: { file: string; mtime: number } | undefined;
	for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
		if (!name.endsWith(".jsonl")) continue;
		const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
		if (!newest || mtime > newest.mtime) newest = { file: path.join(dir, name), mtime };
	}
	if (!newest) {
		console.error(`No Claude Code session in ${process.cwd()} yet.`);
		process.exitCode = 1;
		return;
	}
	const input: StatusInput = { sessionId: path.basename(newest.file, ".jsonl"), transcriptPath: newest.file, cwd: process.cwd(), modelId: "", ttl: undefined, cachingOff: false, subscription: false };
	const session = loadSession(input);
	const last = session.tracker.history.at(-1);
	const e = env({ ...input, modelId: session.model ?? "" }, last ? last.read + last.write + last.uncached : 0);
	for (const l of toAnsi(renderPanel(session.tracker, snapshot(session.tracker, e), e), ANSI, process.stdout.columns || 100)) console.log(l);
	session.save(session.published);
}

function readClaudeSettings(): Record<string, unknown> {
	if (!fs.existsSync(CLAUDE_SETTINGS)) return {};
	const raw: unknown = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${CLAUDE_SETTINGS} is not a JSON object`);
	return Object.fromEntries(Object.entries(raw));
}

function writeClaudeSettings(settings: Record<string, unknown>): void {
	if (fs.existsSync(CLAUDE_SETTINGS)) fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.bak`);
	fs.mkdirSync(CLAUDE_DIR, { recursive: true });
	fs.writeFileSync(`${CLAUDE_SETTINGS}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
	fs.renameSync(`${CLAUDE_SETTINGS}.tmp`, CLAUDE_SETTINGS);
}

/** The command Claude Code should run: the global install's name when the shell finds it, else this script's path. */
function command(): string {
	try {
		const found = execFileSync("sh", ["-lc", `command -v ${NAME}`], { encoding: "utf8" }).trim();
		if (found) return NAME;
	} catch {
		// not on PATH
	}
	return `node ${JSON.stringify(fs.realpathSync(process.argv[1] ?? ""))}`;
}

/** `install`: installs the package globally (unless this already is a global install) and sets the status line. */
function install(): void {
	const settings = readClaudeSettings();
	const existing = settings.statusLine;
	if (existing !== undefined && !String(dig(existing, "command") ?? "").includes(NAME)) {
		console.error(`${CLAUDE_SETTINGS} already has a status line:\n  ${JSON.stringify(existing)}\nRemove it first, or keep it; ${NAME} won't overwrite it.`);
		process.exitCode = 1;
		return;
	}
	const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	if (!fs.realpathSync(process.argv[1] ?? "").startsWith(fs.realpathSync(globalRoot))) {
		console.log(`Installing ${NAME}@${VERSION} globally…`);
		execFileSync("npm", ["install", "-g", `${NAME}@${VERSION}`], { stdio: "inherit" });
	}
	settings.statusLine = { type: "command", command: command(), refreshInterval: 1 };
	writeClaudeSettings(settings);
	console.log(`Status line set in ${CLAUDE_SETTINGS} (previous file kept as settings.json.bak).`);
	console.log(`Claude Code picks it up right away. Settings: ${SETTINGS_FILE}. Remove: ${NAME} uninstall.`);
}

/** `uninstall`: removes the status line this tool set, and its session state. */
function uninstall(): void {
	const settings = readClaudeSettings();
	if (String(dig(settings.statusLine, "command") ?? "").includes(NAME)) {
		delete settings.statusLine;
		writeClaudeSettings(settings);
		console.log(`Status line removed from ${CLAUDE_SETTINGS}.`);
	} else {
		console.log(`${CLAUDE_SETTINGS} has no ${NAME} status line; left unchanged.`);
	}
	fs.rmSync(path.join(CLAUDE_DIR, "cache-meter"), { recursive: true, force: true });
	console.log(`To remove the package too: npm uninstall -g ${NAME}`);
}

const [cmd] = process.argv.slice(2);
if (cmd === "install") install();
else if (cmd === "uninstall") uninstall();
else if (cmd === "panel") panel();
else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else if (cmd === undefined && !process.stdin.isTTY) statusLine(fs.readFileSync(0, "utf8"));
else console.log(`${NAME} ${VERSION}: the omp cache meter as Claude Code's status line.

  ${NAME} install     set it as your status line (~/.claude/settings.json)
  ${NAME} uninstall   remove it
  ${NAME} panel       this directory's newest session: totals and the last requests

Claude Code runs it with the session JSON on stdin.`);
