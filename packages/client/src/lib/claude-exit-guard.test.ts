import { describe, expect, it } from "vitest";
import {
  CLAUDE_EXIT_DOUBLE_PRESS_MS,
  createClaudeExitGuard,
  exitKeyOf,
} from "./claude-exit-guard.js";

function keyEvent(
  init: Partial<KeyboardEvent>,
): Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  };
}

describe("exitKeyOf", () => {
  it.each([
    ["c", "\x03"],
    ["C", "\x03"],
    ["d", "\x04"],
    ["D", "\x04"],
  ])("Ctrl+%s maps to its control byte", (key, byte) => {
    expect(exitKeyOf(keyEvent({ key, ctrlKey: true }))).toBe(byte);
  });

  it.each([
    { key: "c" },
    { key: "c", metaKey: true },
    { key: "c", ctrlKey: true, shiftKey: true },
    { key: "c", ctrlKey: true, altKey: true },
    { key: "c", ctrlKey: true, metaKey: true },
    { key: "x", ctrlKey: true },
  ])("is null for anything but a bare Ctrl+C / Ctrl+D (%o)", (init) => {
    expect(exitKeyOf(keyEvent(init))).toBeNull();
  });
});

describe("createClaudeExitGuard", () => {
  function guard() {
    let now = 0;
    const g = createClaudeExitGuard(() => now);
    return {
      hold: (key: "\x03" | "\x04", claudeTerminalId: string | null = "A") =>
        g.hold(key, claudeTerminalId),
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("lets the first press through", () => {
    expect(guard().hold("\x03")).toBe(false);
  });

  it("holds a second press of the same key inside the window", () => {
    const g = guard();
    g.hold("\x03");
    g.advance(CLAUDE_EXIT_DOUBLE_PRESS_MS);
    expect(g.hold("\x03")).toBe(true);
  });

  it("lets a second press through once the window has passed", () => {
    const g = guard();
    g.hold("\x03");
    g.advance(CLAUDE_EXIT_DOUBLE_PRESS_MS + 1);
    expect(g.hold("\x03")).toBe(false);
  });

  it("holds a double Ctrl+D the same way", () => {
    const g = guard();
    g.hold("\x04");
    expect(g.hold("\x04")).toBe(true);
  });

  it("does not pair Ctrl+C with Ctrl+D", () => {
    const g = guard();
    g.hold("\x03");
    expect(g.hold("\x04")).toBe(false);
  });

  it("does not pair presses in different Cockpit Terminals", () => {
    const g = guard();
    g.hold("\x03", "A");
    expect(g.hold("\x03", "B")).toBe(false);
  });

  it("starts over after a held press, so a third press is a first press again", () => {
    const g = guard();
    g.hold("\x03");
    g.hold("\x03");
    expect(g.hold("\x03")).toBe(false);
  });

  it("never holds without a running Claude Session", () => {
    const g = guard();
    g.hold("\x03", null);
    expect(g.hold("\x03", null)).toBe(false);
  });
});
