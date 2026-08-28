import type { CockpitTerminalState } from "./protocol.js";

// Pure functions for determining session state. The spec of record is session-state.test.ts.

export const DEFAULT_RUN_MARKER = "(esc to interrupt";
export const DEFAULT_BG_AGENT_MARKER = "◯";
/**
 * Line-head markers for the limit-reached banners. Claude Code renders two wordings: the lockout
 * banner (`✗ Claude usage limit reached · /upgrade …`) and the auto-retry banner
 * (`✻ Session limit reached · Retrying in …`).
 */
export const DEFAULT_LIMIT_MARKERS: readonly string[] = [
  "claude usage limit reached",
  "session limit reached",
];

/**
 * Distinctive header phrases of Claude Code's built-in menu/overlay screens (`/login`, `/status`,
 * `/usage`, `/model`, `/mcp`, and the wider settings family). A session showing one of these is
 * sitting in a menu rather than mid-task, so the session list swaps its state glyph for a settings
 * icon. Best-effort defaults matched case-insensitively; extend or replace via `ZK_MENU_MARKERS`
 * when Claude Code's wording changes (the same escape-hatch idea as the run/limit markers).
 */
export const DEFAULT_MENU_MARKERS: readonly string[] = [
  "Select login method",
  "Claude Code Status",
  "Current week (all models)",
  "Select Model",
  "Manage MCP servers",
];

/**
 * The last 8 non-empty lines: a width that absorbs the real layout where, below
 * the running spinner, there are 3 input-box lines plus a mode/shortcut/warning
 * status line. We count non-empty lines because the bottom is padded with blank
 * lines right after rendering.
 */
const BOTTOM_WINDOW_LINES = 8;

function bottomNonEmptyLines(capture: string): string[] {
  const lines = capture.split("\n").filter((line) => /\S/.test(line));
  return lines.slice(Math.max(0, lines.length - BOTTOM_WINDOW_LINES));
}

/**
 * Live-timer line of the running spinner. The new UI drops "(esc to interrupt"
 * and the only clue left is the elapsed timer, e.g.
 * `✻ Razzle-dazzling… (8m 10s · ↓ 34.3k tokens)`. In addition to `(<elapsed>s`
 * right after `…`, we require that the paren also contain a separator `·` or a
 * token counter `↓`. This rejects the completion line `✻ Worked for 5m 42s`
 * (no paren, "for"), `… (ctrl+o to expand)`, and inline `…(30s)` (closing with
 * no separator).
 */
const LIVE_SPINNER_TIMER = /…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s[^)·↓(…]*[·↓]/;

/**
 * Whether a running spinner line is visible in the bottom of the pane (last 8
 * non-empty lines). In addition to a substring match on marker (default
 * "(esc to interrupt"), structurally detect the new UI's live timer (OR).
 * Limiting to the bottom avoids misdetecting a marker quoted in the history body
 * as running.
 */
export function isRunning(
  capture: string,
  marker: string = DEFAULT_RUN_MARKER,
): boolean {
  return bottomNonEmptyLines(capture).some(
    (line) => line.includes(marker) || LIVE_SPINNER_TIMER.test(line),
  );
}

// Leading line decoration (whitespace, a box-border/bullet glyph, or a banner status/spinner glyph)
// stripped before a menu or limit marker is tested at the start of a line, so a centered,
// box-framed, or glyph-prefixed banner line still matches.
const LINE_DECORATION = /^[\s│┃|╎┆>*•·\-─✗✻✳✶✽✢]+/;

/** Lowercased non-empty marker needles for case-insensitive matching (empty result = match nothing). */
function lowercaseNeedles(markers: readonly string[]): string[] {
  return markers.filter((m) => m !== "").map((m) => m.toLowerCase());
}

/** Whether a needle heads the line after stripping leading decoration, case-insensitively. */
function headStartsWith(line: string, needles: readonly string[]): boolean {
  const head = line.replace(LINE_DECORATION, "").toLowerCase();
  return needles.some((n) => head.startsWith(n));
}

/**
 * Detect Claude Code's limit-reached banner from the bottom of the screen (last
 * 8 non-empty lines). A marker must head a line — after stripping leading
 * decoration — case-insensitively, so a quoted occurrence mid-line (i18n
 * resources, docs, chat text) does not trip it while the real banner (glyph +
 * marker at the line head) still does. This is an attribute orthogonal to the
 * main state, so it is not folded into detectState (to avoid making the case
 * where a limit banner appears during running mutually exclusive). An empty
 * marker list (or all-empty markers) falls back to false to avoid false
 * positives (matching every window).
 */
export function isLimitReached(
  capture: string,
  markers: readonly string[] = DEFAULT_LIMIT_MARKERS,
): boolean {
  const needles = lowercaseNeedles(markers);
  if (needles.length === 0) return false;
  return bottomNonEmptyLines(capture).some((line) =>
    headStartsWith(line, needles),
  );
}

/**
 * Whether one of Claude Code's built-in menu/overlay screens is open, i.e. a marker heads any line of
 * the captured screen (case-insensitive, after stripping leading whitespace/border glyphs). Requiring
 * the marker to head a line — not merely appear anywhere — keeps a phrase quoted mid-sentence in the
 * conversation body from tripping the flag, while still scanning the whole capture (overlays render
 * centered, not pinned to the bottom like the running/limit banners). Orthogonal to the main state —
 * it only overrides the rendered glyph, so it is not folded into detectState. An empty marker list
 * (or all-empty markers) yields false.
 */
export function isMenuOpen(
  capture: string,
  markers: readonly string[] = DEFAULT_MENU_MARKERS,
): boolean {
  const needles = lowercaseNeedles(markers);
  if (needles.length === 0) return false;
  return capture.split("\n").some((line) => headStartsWith(line, needles));
}

/**
 * Whether a background subagent is running. When idle, the running spinner loses
 * "(esc to interrupt", and the only clue is the "agents" panel at the very bottom
 * (heading `⏺ main` + a line-leading marker line per running agent). To avoid
 * false positives: require the heading to be present (excludes radio/TODO `◯`)
 * and limit the marker to a line-leading match (first non-whitespace) followed
 * immediately by a space (excludes `◯` in the input box or body text).
 */
export function hasBgAgent(
  capture: string,
  marker: string = DEFAULT_BG_AGENT_MARKER,
): boolean {
  const window = bottomNonEmptyLines(capture);
  if (!window.some((line) => line.includes("⏺ main"))) return false;
  return window.some((line) => line.trimStart().startsWith(`${marker} `));
}

/**
 * Whether it's a numbered-choice wizard (waiting for user input). If there is a
 * selection-cursor line marked with ❯ and 2 or more choice lines in "N." form,
 * treat it as waiting. Unless the counting side allows a ❯ (plus space) right
 * before the digit, a two-choice prompt (permission confirmation
 * "❯ 1. Yes / 2. No") fails to count the cursor line, comes out as 1, and is
 * misdetected as running (a regression of cw missing Bash permission waits).
 */
export function isWizard(capture: string): boolean {
  const lines = capture.split("\n");
  if (!lines.some((line) => /❯\s*[0-9]+\./.test(line))) return false;
  const numbered = lines.filter((line) => /^\s*(?:❯\s*)?[0-9]+\./.test(line));
  return numbered.length >= 2;
}

/**
 * The mtime freshness threshold (seconds) for the count of running subagents.
 * Assuming the transcript is appended every few seconds while running, treat the
 * larger of twice the poll interval or 30 seconds as "fresh = running" (the same
 * freshness convention as fallbackState).
 */
export function subagentFreshWithinSec(pollSec: number): number {
  const poll = Number.isFinite(pollSec) && pollSec > 0 ? pollSec : 2;
  return Math.max(2 * poll, 30);
}

/**
 * Count the total number running from the mtime ages (seconds) of subagent jsonl
 * files (children, grandchildren, and great-grandchildren are recorded flat in
 * the same subagents/). An approximation that treats only files fresh within the
 * threshold as running.
 */
export function countRunningSubagents(
  mtimeAgesSec: readonly number[],
  freshWithinSec: number,
): number {
  return mtimeAgesSec.filter((age) => age <= freshWithinSec).length;
}

/**
 * Task-list footer: `N tasks (X done[, N segment]*)` owning its whole line. Segment labels beyond
 * `done` (`open` / `in progress` today) are not interpreted, so a wording addition in Claude Code
 * does not silently kill the detection.
 */
const TASKS_FOOTER =
  /^\s*(\d+)\s+tasks?\s+\((\d+)\s+done(?:,\s+\d+\s+[a-z][a-z ]*)*\)\s*$/;

/**
 * The remaining task count parsed from the task-list footer: `total - done` when `total > done`,
 * else null (an all-done footer must not read as busy — the same contract as the agent tray).
 * The whole capture is scanned bottom-up: the visible task rows and the input box sit between the
 * footer and the pane bottom, so the footer is not confined to the bottom window.
 */
export function openTasksRemaining(capture: string): number | null {
  const lines = capture.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TASKS_FOOTER.exec(lines[i] ?? "");
    if (!m) continue;
    const total = Number(m[1]);
    const done = Number(m[2]);
    return total > done ? total - done : null;
  }
  return null;
}

export interface DetectStateOptions {
  /** Whether claude (with a sid) is in the process tree of the captured pane. */
  hasClaude: boolean;
  /** Marker for the running spinner (ZK_RUN_MARKER; an escape hatch for wording changes in Claude Code). */
  runMarker?: string;
  /** Marker for the bg agent line (ZK_BG_AGENT_MARKER). */
  bgAgentMarker?: string;
}

/**
 * Capture-based main determination that treats the actual conversation-pane
 * screen as authoritative (following priority order). "idle" means "no clue on
 * the screen", so the caller can chain into the jsonl fallback via fallbackState.
 */
export function detectState(
  capture: string,
  opts: DetectStateOptions,
): CockpitTerminalState {
  if (isWizard(capture)) return "waiting_input";
  // An empty-string marker falls back to the default (equivalent to zsh's
  // ${VAR:-default}; prevents the misconfiguration where includes("") is always
  // true = every window becomes running)
  if (isRunning(capture, opts.runMarker || DEFAULT_RUN_MARKER))
    return "running";
  if (hasBgAgent(capture, opts.bgAgentMarker || DEFAULT_BG_AGENT_MARKER))
    return "running_bg_agent";
  if (!opts.hasClaude) return "no_claude";
  if (openTasksRemaining(capture) !== null) return "watching";
  return "idle";
}

/** The user/assistant event at the end of the transcript (jsonl). */
export interface TranscriptEvent {
  type: "user" | "assistant";
  /** The body text contains an interrupt marker (an Esc interrupt remains as a user line). */
  interrupted: boolean;
}

/**
 * The jsonl fallback for when there is neither a spinner nor a wizard on screen.
 * Rescue to running only when the latest is user (the race right after sending,
 * before the spinner renders); a stale user stick (API error, kill) — stale
 * meaning that while running the transcript is appended every few seconds, so an
 * mtime over max(2×poll, 30) seconds is stale — falls back to idle.
 */
export function fallbackState(
  lastEvent: TranscriptEvent | null,
  mtimeAgeSec: number | null,
  pollSec: number,
): "running" | "idle" {
  const poll = Number.isFinite(pollSec) && pollSec > 0 ? pollSec : 2;
  const maxAgeSec = Math.max(2 * poll, 30);
  const fresh = mtimeAgeSec !== null && mtimeAgeSec <= maxAgeSec;
  return lastEvent?.type === "user" && !lastEvent.interrupted && fresh
    ? "running"
    : "idle";
}
