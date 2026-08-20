import { describe, expect, it, vi } from "vitest";
import {
  handleTerminalKey,
  type TerminalKeyDeps,
} from "./terminal-key-handler.js";

function deps(overrides: Partial<TerminalKeyDeps> = {}): TerminalKeyDeps {
  return {
    getSelection: () => "",
    input: vi.fn(),
    clipboardEditEnabled: true,
    openFind: vi.fn(),
    openClipboardEdit: vi.fn(),
    ...overrides,
  };
}

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: "keydown",
    isComposing: false,
    keyCode: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...init,
  } as KeyboardEvent;
}

describe("handleTerminalKey", () => {
  it("passes through non-keydown events", () => {
    expect(handleTerminalKey(key({ type: "keyup" }), deps())).toBe(true);
  });

  it("passes through during IME composition (isComposing or keyCode 229)", () => {
    expect(handleTerminalKey(key({ isComposing: true }), deps())).toBe(true);
    expect(handleTerminalKey(key({ keyCode: 229 }), deps())).toBe(true);
  });

  it("opens the find bar on Cmd+F and intercepts", () => {
    const d = deps();
    const e = key({ key: "f", metaKey: true });
    expect(handleTerminalKey(e, d)).toBe(false);
    expect(d.openFind).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not treat Ctrl+F or Cmd+Shift+F as find", () => {
    expect(handleTerminalKey(key({ key: "f", ctrlKey: true }), deps())).toBe(
      true,
    );
    expect(
      handleTerminalKey(
        key({ key: "f", metaKey: true, shiftKey: true }),
        deps(),
      ),
    ).toBe(true);
  });

  it("opens the clipboard-edit modal on Cmd+C when the selection warrants it", () => {
    const d = deps({ getSelection: () => "line1\nline2" });
    const e = key({ key: "c", metaKey: true });
    expect(handleTerminalKey(e, d)).toBe(false);
    expect(d.openClipboardEdit).toHaveBeenCalledWith("line1\nline2");
  });

  it("passes Cmd+C through for a single-line selection", () => {
    const d = deps({ getSelection: () => "oneline" });
    expect(handleTerminalKey(key({ key: "c", metaKey: true }), d)).toBe(true);
    expect(d.openClipboardEdit).not.toHaveBeenCalled();
  });

  it("passes Cmd+C through when the clipboard-edit modal is disabled", () => {
    const d = deps({
      getSelection: () => "line1\nline2",
      clipboardEditEnabled: false,
    });
    expect(handleTerminalKey(key({ key: "c", metaKey: true }), d)).toBe(true);
    expect(d.openClipboardEdit).not.toHaveBeenCalled();
  });

  it("sends a meta-return for Shift+Enter and intercepts", () => {
    const d = deps();
    expect(handleTerminalKey(key({ key: "Enter", shiftKey: true }), d)).toBe(
      false,
    );
    expect(d.input).toHaveBeenCalledWith("\x1b\r");
  });

  it("maps Cmd+Right/Left to end/beginning of line", () => {
    const right = deps();
    expect(
      handleTerminalKey(key({ key: "ArrowRight", metaKey: true }), right),
    ).toBe(false);
    expect(right.input).toHaveBeenCalledWith("\x05");

    const left = deps();
    expect(
      handleTerminalKey(key({ key: "ArrowLeft", metaKey: true }), left),
    ).toBe(false);
    expect(left.input).toHaveBeenCalledWith("\x01");
  });

  it("passes ordinary keys through", () => {
    const d = deps();
    expect(handleTerminalKey(key({ key: "a" }), d)).toBe(true);
    expect(d.input).not.toHaveBeenCalled();
  });
});
