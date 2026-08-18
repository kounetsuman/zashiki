/**
 * Decides whether a terminal fit result (cols/rows) should trigger resending a resize to the server.
 *
 * xterm.js renders at a width discretized to cols × cell width. When the available width of
 * `.terminal-view` exceeds the xterm cols width, the difference remains as black empty space to the
 * right of the main area (measured: at 1120px width, leaving cols=61 leaves 639px of empty
 * space on the right; once fit bumps cols to 143, the gap disappears).
 *
 * FitAddon.fit() becomes a no-op while cell dimensions are undetermined (right after `term.open`),
 * freezing cols at an undersized value. TerminalView keeps a single instance mounted at all times and
 * switches windows via session.select, so useEffect does not re-run and the initial fit is never
 * retried. We therefore re-run fit on the first render (onRender) and send a resize only when cols/rows
 * change (preserving the guard against empty resize loops).
 */

import { isUsableTerminalSize, type TerminalSize } from "@zashiki/shared";

export type { TerminalSize };

/**
 * Send a resize only when the post-fit cols/rows differ from the last sent value.
 * Does not send NaN, non-positive, or undersized dimensions (fit with undetermined cells / tiny actual
 * sizes mid-layout).
 */
export function shouldSendResize(
  last: TerminalSize,
  next: TerminalSize,
): boolean {
  if (!isValidSize(next)) return false;
  return next.cols !== last.cols || next.rows !== last.rows;
}

/**
 * Whether cols/rows are valid values usable for actual rendering. Requires positive integers plus a
 * practical minimum, rejecting as "undetermined" the tiny "actual sizes" that proposeDimensions()
 * returns mid-layout (which collapse the shared window and cause infinite footer repetition). The
 * check and its lower bound are centralized in `isUsableTerminalSize` of `@zashiki/shared` (using the
 * same threshold as the server's lower-bound clamp).
 */
export function isValidSize(size: TerminalSize): boolean {
  return isUsableTerminalSize(size);
}
