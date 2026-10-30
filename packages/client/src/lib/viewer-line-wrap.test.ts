import { describe, expect, it } from "vitest";

import { loadViewerLineWrap, saveViewerLineWrap } from "./viewer-line-wrap.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("viewer line-wrap preference", () => {
  it("starts unwrapped and round-trips both states", () => {
    const s = memoryStorage();
    expect(loadViewerLineWrap(s)).toBe(false);
    saveViewerLineWrap(s, true);
    expect(loadViewerLineWrap(s)).toBe(true);
    saveViewerLineWrap(s, false);
    expect(loadViewerLineWrap(s)).toBe(false);
  });

  it("stays unwrapped without storage", () => {
    expect(loadViewerLineWrap(null)).toBe(false);
    expect(() => saveViewerLineWrap(null, true)).not.toThrow();
  });

  it("stays unwrapped when the read fails", () => {
    const s = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(loadViewerLineWrap(s)).toBe(false);
  });

  it("swallows a failing write", () => {
    const s = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveViewerLineWrap(s, true)).not.toThrow();
  });
});
