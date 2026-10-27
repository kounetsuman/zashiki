import { describe, expect, it } from "vitest";

import {
  loadFooterBeforeCompactionOpen,
  saveFooterBeforeCompactionOpen,
} from "./footer-before-compaction.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("footer before-compaction toggle", () => {
  it("starts closed and round-trips both states", () => {
    const s = memoryStorage();
    expect(loadFooterBeforeCompactionOpen(s)).toBe(false);
    saveFooterBeforeCompactionOpen(s, true);
    expect(loadFooterBeforeCompactionOpen(s)).toBe(true);
    saveFooterBeforeCompactionOpen(s, false);
    expect(loadFooterBeforeCompactionOpen(s)).toBe(false);
  });

  it("stays closed without storage", () => {
    expect(loadFooterBeforeCompactionOpen(null)).toBe(false);
    expect(() => saveFooterBeforeCompactionOpen(null, true)).not.toThrow();
  });
});
