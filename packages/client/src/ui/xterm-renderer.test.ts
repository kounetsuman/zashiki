import { describe, expect, it } from "vitest";

import {
  DEFAULT_XTERM_RENDERER,
  isXtermRenderer,
  loadXtermRenderer,
  saveXtermRenderer,
  XTERM_RENDERER_KEY,
} from "./xterm-renderer.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    get: (k: string) => map.get(k) ?? null,
  };
}

describe("isXtermRenderer", () => {
  it("accepts the supported values and rejects anything else", () => {
    expect(isXtermRenderer("webgl")).toBe(true);
    expect(isXtermRenderer("dom")).toBe(true);
    expect(isXtermRenderer("canvas")).toBe(false);
    expect(isXtermRenderer(null)).toBe(false);
  });
});

describe("loadXtermRenderer", () => {
  it("defaults when storage is null, empty, or holds an unknown value", () => {
    expect(loadXtermRenderer(null)).toBe(DEFAULT_XTERM_RENDERER);
    expect(loadXtermRenderer(fakeStorage())).toBe(DEFAULT_XTERM_RENDERER);
    expect(
      loadXtermRenderer(fakeStorage({ [XTERM_RENDERER_KEY]: "canvas" })),
    ).toBe(DEFAULT_XTERM_RENDERER);
  });

  it("reads a persisted supported value", () => {
    expect(
      loadXtermRenderer(fakeStorage({ [XTERM_RENDERER_KEY]: "dom" })),
    ).toBe("dom");
  });
});

describe("saveXtermRenderer", () => {
  it("persists the value under the renderer key", () => {
    const storage = fakeStorage();
    saveXtermRenderer(storage, "dom");
    expect(storage.get(XTERM_RENDERER_KEY)).toBe("dom");
  });

  it("does not throw on a null storage", () => {
    expect(() => saveXtermRenderer(null, "webgl")).not.toThrow();
  });
});
