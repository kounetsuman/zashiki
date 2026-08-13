export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Practical lower bounds for terminal size.
 *
 * `FitAddon.proposeDimensions()` can, during a mid-layout frame (a tab opening
 * right after a new session is created, or while cell dimensions are still being
 * settled after allowProposedApi is enabled), return not undefined but a tiny
 * "real size" (cols/rows of a few cells). If this is passed to start/attach/resize,
 * the shared work window of `window-size latest` collapses to a tiny size, and
 * Claude's footer wraps and repeats vertically without end (a redraw flap).
 * Therefore, anything below the lower bound is treated as "dimensions not yet settled".
 *
 * Any real, usable terminal will not fall below this value. Raising the lower bound
 * too high would regress toward rejecting narrow windows, so keep it a conservative
 * value that only rejects obvious transient garbage.
 */
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 5;

/** Whether this is a settled size usable for start/resize (a positive integer at or above the practical lower bound). */
export function isUsableTerminalSize(size: TerminalSize): boolean {
  return (
    Number.isInteger(size.cols) &&
    Number.isInteger(size.rows) &&
    size.cols >= MIN_TERMINAL_COLS &&
    size.rows >= MIN_TERMINAL_ROWS
  );
}

/**
 * Clamps cols/rows up to the practical lower bound (the server's last line of defense).
 * Defense in depth so that even if the client mistakenly sends a tiny size, the shared
 * window is not collapsed. Non-integers are truncated. `clamped` is true only when a value
 * was raised to the lower bound (i.e. an undersized value was detected), and is used as the
 * firing condition for log metrics.
 */
export function clampTerminalSize(size: TerminalSize): {
  cols: number;
  rows: number;
  clamped: boolean;
} {
  const cols = Math.max(Math.trunc(size.cols), MIN_TERMINAL_COLS);
  const rows = Math.max(Math.trunc(size.rows), MIN_TERMINAL_ROWS);
  return { cols, rows, clamped: cols !== size.cols || rows !== size.rows };
}
