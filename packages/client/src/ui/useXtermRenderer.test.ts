// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useXtermRenderer } from "./useXtermRenderer.js";
import { XTERM_RENDERER_KEY } from "./xterm-renderer.js";

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

describe("useXtermRenderer", () => {
  it("initializes from the persisted value", () => {
    const storage = fakeStorage({ [XTERM_RENDERER_KEY]: "dom" });
    const { result } = renderHook(() => useXtermRenderer(storage));
    expect(result.current.renderer).toBe("dom");
  });

  it("setRenderer changes the value and persists it", () => {
    const storage = fakeStorage();
    const { result } = renderHook(() => useXtermRenderer(storage));
    expect(result.current.renderer).toBe("webgl");
    act(() => result.current.setRenderer("dom"));
    expect(result.current.renderer).toBe("dom");
    expect(storage.read(XTERM_RENDERER_KEY)).toBe("dom");
  });
});
