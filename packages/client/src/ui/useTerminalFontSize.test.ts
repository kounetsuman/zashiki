// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_KEY,
} from "./terminal-font-size.js";
import { useTerminalFontSize } from "./useTerminalFontSize.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    read: (k: string) => map.get(k) ?? null,
  };
}

afterEach(() => undefined);

describe("useTerminalFontSize", () => {
  it("initializes from the persisted value", () => {
    const storage = fakeStorage({ [TERMINAL_FONT_SIZE_KEY]: "18" });
    const { result } = renderHook(() => useTerminalFontSize(storage));
    expect(result.current.fontSize).toBe(18);
  });

  it("increase/decrease change the size and persist it", () => {
    const storage = fakeStorage();
    const { result } = renderHook(() => useTerminalFontSize(storage));
    act(() => result.current.increase());
    expect(result.current.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE + 1);
    expect(storage.read(TERMINAL_FONT_SIZE_KEY)).toBe(
      String(DEFAULT_TERMINAL_FONT_SIZE + 1),
    );
    act(() => result.current.decrease());
    act(() => result.current.decrease());
    expect(result.current.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE - 1);
  });

  it("reset returns to the default", () => {
    const storage = fakeStorage({ [TERMINAL_FONT_SIZE_KEY]: "24" });
    const { result } = renderHook(() => useTerminalFontSize(storage));
    act(() => result.current.reset());
    expect(result.current.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("canReset is false at the default and true once changed", () => {
    const storage = fakeStorage();
    const { result } = renderHook(() => useTerminalFontSize(storage));
    expect(result.current.canReset).toBe(false);
    act(() => result.current.increase());
    expect(result.current.canReset).toBe(true);
    act(() => result.current.reset());
    expect(result.current.canReset).toBe(false);
  });

  it("exposes canIncrease/canDecrease at the boundaries", () => {
    const atMax = fakeStorage({
      [TERMINAL_FONT_SIZE_KEY]: String(MAX_TERMINAL_FONT_SIZE),
    });
    const { result: max } = renderHook(() => useTerminalFontSize(atMax));
    expect(max.current.canIncrease).toBe(false);
    expect(max.current.canDecrease).toBe(true);

    const atMin = fakeStorage({
      [TERMINAL_FONT_SIZE_KEY]: String(MIN_TERMINAL_FONT_SIZE),
    });
    const { result: min } = renderHook(() => useTerminalFontSize(atMin));
    expect(min.current.canDecrease).toBe(false);
    expect(min.current.canIncrease).toBe(true);
  });
});
