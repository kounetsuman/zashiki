// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  type AppKeyboardShortcuts,
  useAppKeyboardShortcuts,
} from "./useAppKeyboardShortcuts.js";

function makeProps(
  over: Partial<AppKeyboardShortcuts> = {},
): AppKeyboardShortcuts {
  return {
    cockpitTerminals: [],
    orgs: [],
    activeSess: null,
    activeKey: null,
    handleSelectView: vi.fn(),
    toggleHelp: vi.fn(),
    toggleSettings: vi.fn(),
    newSession: vi.fn(),
    duplicateSession: vi.fn(),
    closeTabByKey: vi.fn(),
    openQuickOpen: vi.fn(),
    openFile: vi.fn(),
    ...over,
  };
}

function pressKey(key: string, mods: Partial<KeyboardEventInit> = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...mods }));
}

describe("useAppKeyboardShortcuts", () => {
  it("Cmd+B selects the explorer view (which toggles it open/closed)", () => {
    const handleSelectView = vi.fn();
    renderHook(() => useAppKeyboardShortcuts(makeProps({ handleSelectView })));
    pressKey("b", { metaKey: true });
    expect(handleSelectView).toHaveBeenCalledExactlyOnceWith("explorer");
  });

  it("ignores b without the meta key, and Cmd+B with extra modifiers", () => {
    const handleSelectView = vi.fn();
    renderHook(() => useAppKeyboardShortcuts(makeProps({ handleSelectView })));
    pressKey("b");
    pressKey("b", { metaKey: true, shiftKey: true });
    pressKey("b", { metaKey: true, ctrlKey: true });
    pressKey("b", { metaKey: true, altKey: true });
    expect(handleSelectView).not.toHaveBeenCalled();
  });

  it("Cmd+P opens the quick-open palette", () => {
    const openQuickOpen = vi.fn();
    renderHook(() => useAppKeyboardShortcuts(makeProps({ openQuickOpen })));
    pressKey("p", { metaKey: true });
    expect(openQuickOpen).toHaveBeenCalledOnce();
  });

  it("Cmd+O opens the native file picker", () => {
    const openFile = vi.fn();
    renderHook(() => useAppKeyboardShortcuts(makeProps({ openFile })));
    pressKey("o", { metaKey: true });
    expect(openFile).toHaveBeenCalledOnce();
  });

  it("ignores p/o without the meta key or with extra modifiers", () => {
    const openQuickOpen = vi.fn();
    const openFile = vi.fn();
    renderHook(() =>
      useAppKeyboardShortcuts(makeProps({ openQuickOpen, openFile })),
    );
    pressKey("p");
    pressKey("p", { metaKey: true, shiftKey: true });
    pressKey("o");
    pressKey("o", { metaKey: true, altKey: true });
    expect(openQuickOpen).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });
});
