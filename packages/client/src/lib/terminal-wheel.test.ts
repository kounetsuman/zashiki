import { describe, expect, it } from "vitest";

import { wheelDeltaToLines } from "./terminal-wheel.js";

// deltaMode constants (WheelEvent): 0 = pixel, 1 = line, 2 = page.
describe("wheelDeltaToLines", () => {
  it("divides pixel deltas by the cell height, rounding away from zero", () => {
    // 48px down at a 16px cell = 3 lines down.
    expect(wheelDeltaToLines({ deltaY: 48, deltaMode: 0 }, 16, 24)).toBe(3);
    // 48px up = 3 lines up.
    expect(wheelDeltaToLines({ deltaY: -48, deltaMode: 0 }, 16, 24)).toBe(-3);
  });

  it("advances at least one line for a sub-cell pixel notch", () => {
    expect(wheelDeltaToLines({ deltaY: 4, deltaMode: 0 }, 16, 24)).toBe(1);
    expect(wheelDeltaToLines({ deltaY: -4, deltaMode: 0 }, 16, 24)).toBe(-1);
  });

  it("counts line deltas directly", () => {
    expect(wheelDeltaToLines({ deltaY: 2, deltaMode: 1 }, 16, 24)).toBe(2);
    expect(wheelDeltaToLines({ deltaY: -1, deltaMode: 1 }, 16, 24)).toBe(-1);
  });

  it("scales page deltas by the row count", () => {
    expect(wheelDeltaToLines({ deltaY: 1, deltaMode: 2 }, 16, 24)).toBe(24);
    expect(wheelDeltaToLines({ deltaY: -1, deltaMode: 2 }, 16, 40)).toBe(-40);
  });

  it("returns 0 when there is no vertical component or the delta is not finite", () => {
    expect(wheelDeltaToLines({ deltaY: 0, deltaMode: 0 }, 16, 24)).toBe(0);
    expect(
      wheelDeltaToLines({ deltaY: Number.NaN, deltaMode: 0 }, 16, 24),
    ).toBe(0);
  });

  it("falls back to a default cell height when the measured height is unusable", () => {
    // cellHeightPx <= 0 / NaN must not yield 0 or NaN lines; a 32px notch clears at least one line.
    expect(wheelDeltaToLines({ deltaY: 32, deltaMode: 0 }, 0, 24)).toBe(2);
    expect(
      wheelDeltaToLines({ deltaY: 32, deltaMode: 0 }, Number.NaN, 24),
    ).toBe(2);
  });
});
