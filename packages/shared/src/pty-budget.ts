/**
 * Observation logic for the PTY (pseudo-terminal) budget (macOS only).
 *
 * On a development machine, login shells leaked by e2e ate up `kern.tty.ptmx_max`,
 * breaking session creation / restore with `fork failed: Device not configured`
 * (ENXIO). This module holds only "observation" pure functions (actually running
 * ps / sysctl is server/infra's job; no automatic kill is included).
 *
 * The estimate for used is the distinct ttys from `ps -o tty=` (the very metric the
 * measurements used). This is the set of ttys for processes that have a controlling
 * terminal, and it cannot count masters that survive after the slave is closed (the
 * actual leak), so it is systematically an **undercount**. Therefore used is treated
 * as a "lower bound": the UI prefixes it with `≥`, and the block decision carries a
 * safety margin (RESERVE). The source of truth for the decisions and translations is this file's pty-budget.test.ts.
 */

/** Usage ratio at which the warning is shown (warn when >=). */
export const PTY_WARN_RATIO = 0.8;
/** Usage ratio at which the warning is cleared (ok when <; the lower side of the hysteresis). */
export const PTY_WARN_CLEAR_RATIO = 0.75;
/** Usage ratio at which the block is shown (block when >=). */
export const PTY_BLOCK_RATIO = 0.95;
/** Usage ratio at which the block is cleared and drops to warn (when <; the lower side of the hysteresis). */
export const PTY_BLOCK_CLEAR_RATIO = 0.9;

/** Fallback max when the sysctl fetch fails (macOS default kern.tty.ptmx_max). */
export const PTY_MAX_FALLBACK = 511;

/**
 * Absolute slots kept free when blocking creation (a safety margin for used being a
 * lower bound and for the app's own terminal overhead). The hard block uses an absolute
 * slot count rather than a ratio (a ratio-based block would be an off-by-one that fires even when plenty of slots remain).
 */
export const PTY_CREATE_RESERVE = 8;

export interface PtyBudget {
  /** Number of ptys in use (distinct ttys; actually a lower bound, i.e. usage may be higher). */
  used: number;
  /** Max (sysctl kern.tty.ptmx_max; PTY_MAX_FALLBACK when the fetch fails). */
  max: number;
}

/** Severity level for display and notifications. */
export type PtyLevel = "ok" | "warn" | "block";

const TTY_RE = /^ttys\d+$/;

/**
 * Counts the number of distinct real ttys from `ps ... -o tty= ...` output (the tty is the first column of each line).
 * `??` / `-` / empty / non-macOS formats (pts/N etc.) are excluded as having no controlling terminal.
 * Multiple processes sharing the same tty are counted as 1 (approximating a single pty master).
 */
export function countDistinctTtys(psOutput: string): number {
  const ttys = new Set<string>();
  for (const line of psOutput.split("\n")) {
    const token = line.trim().split(/\s+/)[0] ?? "";
    if (TTY_RE.test(token)) ttys.add(token);
  }
  return ttys.size;
}

/** Interprets the raw sysctl output as the max (accepts only integers > 0; invalid falls back). */
export function parsePtyMax(sysctlOutput: string): number {
  const n = Number(sysctlOutput.trim());
  return Number.isInteger(n) && n > 0 ? n : PTY_MAX_FALLBACK;
}

/** Usage ratio (0..1). max <= 0 falls back to 0 (guards against division by zero and invalid max). */
export function ptyUsageRatio(budget: PtyBudget): number {
  if (!Number.isFinite(budget.max) || budget.max <= 0) return 0;
  return budget.used / budget.max;
}

/**
 * Level transition with hysteresis. Taking the previous level into account, it
 * suppresses oscillation at boundaries (notify spam / badge flicker). It uses the
 * enter threshold when rising and the clear threshold when falling.
 */
export function nextPtyLevel(prev: PtyLevel, budget: PtyBudget): PtyLevel {
  const r = ptyUsageRatio(budget);
  if (prev === "block")
    return r < PTY_BLOCK_CLEAR_RATIO ? nextFromWarn(r) : "block";
  if (prev === "warn") {
    if (r >= PTY_BLOCK_RATIO) return "block";
    return r < PTY_WARN_CLEAR_RATIO ? "ok" : "warn";
  }
  // prev === "ok"
  return nextFromOk(r);
}

function nextFromOk(r: number): PtyLevel {
  if (r >= PTY_BLOCK_RATIO) return "block";
  if (r >= PTY_WARN_RATIO) return "warn";
  return "ok";
}

function nextFromWarn(r: number): PtyLevel {
  // Re-evaluation right after dropping down from block (already confirmed below block_clear).
  return r < PTY_WARN_CLEAR_RATIO ? "ok" : "warn";
}

/** True only when the severity has risen (notify only on escalation; not on de-escalation or same level). */
export function isPtyLevelEscalation(prev: PtyLevel, next: PtyLevel): boolean {
  const rank: Record<PtyLevel, number> = { ok: 0, warn: 1, block: 2 };
  return rank[next] > rank[prev];
}

/**
 * Whether it is allowed to newly allocate need ptys (fail-fast).
 * The hard block is an absolute slot count: not allowed if used + inflight + need exceeds max - RESERVE.
 * inflight is "the number of creations this app has accepted since the last measurement and that are not yet reflected in it".
 */
export function canCreatePty(
  budget: PtyBudget,
  opts: { need?: number; inflight?: number } = {},
): boolean {
  const need = opts.need ?? 1;
  const inflight = opts.inflight ?? 0;
  if (!Number.isFinite(budget.max) || budget.max <= 0) return false;
  const projected = budget.used + inflight + need;
  return projected <= budget.max - PTY_CREATE_RESERVE;
}

/**
 * Whether this is a pty allocation failure (ENXIO family). A
 * `fork failed` due to EAGAIN (process-count limit) is a different cause, so it is not picked up on its own (to prevent misdiagnosis).
 */
export function isPtyExhaustionError(message: string): boolean {
  const m = message.toLowerCase();
  if (/device not configured/.test(m)) return true;
  if (/enxio/.test(m)) return true;
  if (/openpty|out of ptys|no more ptys|ptmx/.test(m)) return true;
  // Treat "fork failed" as pty exhaustion only when accompanied by device not configured / ENXIO.
  if (/fork failed/.test(m) && /device not configured|enxio/.test(m))
    return true;
  return false;
}

/**
 * Translates a raw PTY allocation error into a typed PTY-exhaustion message.
 * Since used is a lower bound, it prefixes `≥`, and it appends the original text for debugging.
 */
export function translatePtyError(
  rawMessage: string,
  budget: PtyBudget,
): string {
  return (
    `PTY（疑似端末）が枯渇しています（使用 ≥${budget.used} / 上限 ${budget.max}）。` +
    `不要なタブ/セッションを閉じてから再試行してください。（原因: ${rawMessage}）`
  );
}
