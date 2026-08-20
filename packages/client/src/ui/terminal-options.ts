import type { ITerminalOptions } from "@xterm/xterm";

import { DEFAULT_TERMINAL_FONT_SIZE } from "./terminal-font-size.js";

/**
 * Client-side viewable scrollback (lines). The server retains the full session history without
 * eviction and replays it on attach; this is the browser-side cap on how many of those lines xterm
 * keeps addressable, chosen large enough that the very first prompt stays reachable for realistic
 * cockpit terminals. xterm grows its buffer lazily up to this cap, so memory tracks the lines actually seen.
 */
export const TERMINAL_SCROLLBACK_LINES = 100_000;

/**
 * xterm.js construction options. Factored out into a pure function and covered by unit tests.
 *
 * - `scrollback`: history of plain shell output (not using the alternate screen) is owned by
 *   xterm. Scrolling inside a TUI (alternate screen) is handled by the TUI itself.
 * - `mouseEventsRequireAlt`: even during mouse tracking, route ordinary drag without modifiers to
 *   xterm.js's native selection (mouse click/drag/move are sent to the app only when Alt is held).
 *   Wheel events are exempt from this constraint, so xterm's native scrolling works as-is (added in
 *   xterm.js 6.1; `shouldForceSelection` forces selection when Alt is not held. Verified in the lib
 *   that the wheel check excludes kind 4 = unaffected).
 * - `macOptionClickForcesSelection: false`: not used. When true, Option-drag becomes a selection only
 *   while mouse mode is inactive, which inverts the meaning of "Option/Alt = forward to app" during
 *   mouse mode and confuses users. Selection is always unified to modifier-less drag.
 * - `rightClickSelectsWord`: right-click selects a word (rides the onSelectionChange auto-copy).
 * - `smoothScrollDuration` / `scrollSensitivity`: tuning of native inertial scrolling over the
 *   xterm-owned scrollback.
 */
export function buildTerminalOptions(
  fontSize: number = DEFAULT_TERMINAL_FONT_SIZE,
): ITerminalOptions {
  return {
    // TerminalView sets unicode.activeVersion="11" (proposed API).
    // Without this flag xterm.js throws on construction, and TerminalView's render fails,
    // leaving the whole app on a blank screen.
    allowProposedApi: true,
    scrollback: TERMINAL_SCROLLBACK_LINES,
    // The WebGL renderer (TerminalView) paints to a canvas, so terminal text is not in the DOM.
    // screenReaderMode keeps a live text mirror in the accessibility tree, which restores assistive-tech
    // readability and lets e2e assert on-screen output regardless of the renderer.
    screenReaderMode: true,
    fontSize,
    // Include a monospace CJK font in the fallback. With only Western fonts, Japanese uses a
    // synthesized fallback where full-width and cell width mismatch, so characters overflow their
    // cell and "float". Place Hiragino (macOS's standard monospace CJK) at the end so it meshes with
    // the full-width=2-cell Unicode11 width table (enabled in TerminalView).
    fontFamily:
      "Menlo, Monaco, 'Courier New', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', monospace",
    theme: { background: "#141414" },
    mouseEventsRequireAlt: true,
    macOptionClickForcesSelection: false,
    rightClickSelectsWord: true,
    smoothScrollDuration: 80,
    scrollSensitivity: 3,
  };
}
