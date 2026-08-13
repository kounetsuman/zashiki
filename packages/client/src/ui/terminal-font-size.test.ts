import { describe, expect, it } from "vitest";

import {
  canDecreaseTerminalFontSize,
  canIncreaseTerminalFontSize,
  clampTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  loadTerminalFontSize,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  saveTerminalFontSize,
  stepTerminalFontSize,
  TERMINAL_FONT_SIZE_KEY,
} from "./terminal-font-size.js";

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

describe("clampTerminalFontSize", () => {
  it("keeps an in-range value unchanged", () => {
    expect(clampTerminalFontSize(13)).toBe(13);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampTerminalFontSize(MIN_TERMINAL_FONT_SIZE - 5)).toBe(
      MIN_TERMINAL_FONT_SIZE,
    );
    expect(clampTerminalFontSize(MAX_TERMINAL_FONT_SIZE + 5)).toBe(
      MAX_TERMINAL_FONT_SIZE,
    );
  });

  it("rounds fractional input", () => {
    expect(clampTerminalFontSize(13.6)).toBe(14);
  });

  it("falls back to the default on non-finite input", () => {
    expect(clampTerminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_TERMINAL_FONT_SIZE,
    );
  });
});

describe("stepTerminalFontSize", () => {
  it("increments and decrements by one step", () => {
    expect(stepTerminalFontSize(13, 1)).toBe(14);
    expect(stepTerminalFontSize(13, -1)).toBe(12);
  });

  it("does not exceed the range at the boundaries", () => {
    expect(stepTerminalFontSize(MAX_TERMINAL_FONT_SIZE, 1)).toBe(
      MAX_TERMINAL_FONT_SIZE,
    );
    expect(stepTerminalFontSize(MIN_TERMINAL_FONT_SIZE, -1)).toBe(
      MIN_TERMINAL_FONT_SIZE,
    );
  });
});

describe("canIncrease/canDecreaseTerminalFontSize", () => {
  it("disables enlarging at the maximum and shrinking at the minimum", () => {
    expect(canIncreaseTerminalFontSize(MAX_TERMINAL_FONT_SIZE)).toBe(false);
    expect(canIncreaseTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)).toBe(true);
    expect(canDecreaseTerminalFontSize(MIN_TERMINAL_FONT_SIZE)).toBe(false);
    expect(canDecreaseTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)).toBe(true);
  });
});

describe("loadTerminalFontSize", () => {
  it("returns the default when storage is null", () => {
    expect(loadTerminalFontSize(null)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("returns the default when nothing is stored", () => {
    expect(loadTerminalFontSize(fakeStorage())).toBe(
      DEFAULT_TERMINAL_FONT_SIZE,
    );
  });

  it("reads a persisted in-range value", () => {
    expect(
      loadTerminalFontSize(fakeStorage({ [TERMINAL_FONT_SIZE_KEY]: "18" })),
    ).toBe(18);
  });

  it("falls back to the default on a non-numeric value", () => {
    expect(
      loadTerminalFontSize(fakeStorage({ [TERMINAL_FONT_SIZE_KEY]: "abc" })),
    ).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("clamps a persisted out-of-range value back into range", () => {
    expect(
      loadTerminalFontSize(fakeStorage({ [TERMINAL_FONT_SIZE_KEY]: "999" })),
    ).toBe(MAX_TERMINAL_FONT_SIZE);
  });
});

describe("saveTerminalFontSize", () => {
  it("persists a clamped integer string", () => {
    const storage = fakeStorage();
    saveTerminalFontSize(storage, 999);
    expect(storage.get(TERMINAL_FONT_SIZE_KEY)).toBe(
      String(MAX_TERMINAL_FONT_SIZE),
    );
  });

  it("does not throw when storage is null", () => {
    expect(() => saveTerminalFontSize(null, 16)).not.toThrow();
  });
});
