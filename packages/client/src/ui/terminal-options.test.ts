import { describe, expect, it } from "vitest";

import { DEFAULT_TERMINAL_FONT_SIZE } from "./terminal-font-size.js";
import { buildTerminalOptions } from "./terminal-options.js";

describe("buildTerminalOptions", () => {
  it("after removing tmux, xterm owns the scrollback", () => {
    expect(buildTerminalOptions().scrollback).toBe(10000);
  });

  it("uses the default font size when none is given", () => {
    expect(buildTerminalOptions().fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("reflects the font size passed by the caller", () => {
    expect(buildTerminalOptions(20).fontSize).toBe(20);
  });

  it("falls back to native selection on a plain drag without modifier keys even during tmux mouse mode", () => {
    expect(buildTerminalOptions().mouseEventsRequireAlt).toBe(true);
  });

  it("has no Option-only selection path (avoids the inversion where Option becomes selection only when mouse mode is inactive)", () => {
    expect(buildTerminalOptions().macOptionClickForcesSelection).toBe(false);
  });

  it("selects a word on right-click (rides the auto-copy)", () => {
    expect(buildTerminalOptions().rightClickSelectsWord).toBe(true);
  });

  it("includes a CJK monospace font in the fallback (prevents Japanese from overflowing the cell width)", () => {
    const fontFamily = buildTerminalOptions().fontFamily ?? "";
    expect(fontFamily).toMatch(/Hiragino|Noto Sans CJK|Yu Gothic/);
  });

  // Because TerminalView sets unicode.activeVersion="11" (proposed API),
  // without this flag xterm.js throws on construction, and TerminalView's render failure
  // leaves the whole app on a blank screen.
  it("allows the Unicode11 activeVersion setting (proposed API) via allowProposedApi", () => {
    expect(buildTerminalOptions().allowProposedApi).toBe(true);
  });

  it("has inertial scroll settings for the xterm-owned scrollback", () => {
    const opts = buildTerminalOptions();
    expect(opts.smoothScrollDuration).toBeGreaterThan(0);
    expect(opts.scrollSensitivity).toBeGreaterThan(0);
  });
});
