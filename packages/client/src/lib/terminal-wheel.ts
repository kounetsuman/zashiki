/**
 * Converts a wheel event into a signed scrollback line delta, independent of xterm.js's
 * user-agent-based wheel handling.
 *
 * xterm.js picks its wheel-delta normalization from the user agent
 * (`isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)`). A WKWebView user agent
 * carries no "Safari" token, so inside the packaged Tauri app (WKWebView on macOS) that branch is not
 * taken and the wheel stops scrolling the viewport, while the same build scrolls under Chrome (Blink).
 * Deriving the delta here lets the caller drive `term.scrollLines()` so wheel scrollback behaves the
 * same on both engines (issue #195; upstream xtermjs/xterm.js#3575).
 *
 * Negative scrolls up, toward older history. Returns 0 when the event has no vertical component. Line
 * deltas count directly, page deltas scale by the row count, and pixel deltas divide by the cell
 * height. The magnitude rounds away from zero so a small notch still advances one line.
 */

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
// Cell-height fallback (px) when the terminal has not been measured yet; a typical monospace row.
const FALLBACK_CELL_PX = 16;

export function wheelDeltaToLines(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  cellHeightPx: number,
  rows: number,
): number {
  const { deltaY, deltaMode } = event;
  if (!deltaY || !Number.isFinite(deltaY)) return 0;

  let lines: number;
  if (deltaMode === DOM_DELTA_LINE) {
    lines = deltaY;
  } else if (deltaMode === DOM_DELTA_PAGE) {
    lines = deltaY * Math.max(1, rows);
  } else {
    const cell =
      Number.isFinite(cellHeightPx) && cellHeightPx > 0
        ? cellHeightPx
        : FALLBACK_CELL_PX;
    lines = deltaY / cell;
  }

  const magnitude = Math.max(1, Math.round(Math.abs(lines)));
  return deltaY > 0 ? magnitude : -magnitude;
}
