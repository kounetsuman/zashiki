import { describe, expect, it } from "vitest";

import {
  clampTerminalSize,
  isUsableTerminalSize,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from "./terminal-size.js";

describe("isUsableTerminalSize", () => {
  it("practical sizes are usable", () => {
    expect(isUsableTerminalSize({ cols: 80, rows: 24 })).toBe(true);
    expect(isUsableTerminalSize({ cols: 143, rows: 40 })).toBe(true);
  });

  it("exactly the minimum is usable (boundary)", () => {
    expect(
      isUsableTerminalSize({
        cols: MIN_TERMINAL_COLS,
        rows: MIN_TERMINAL_ROWS,
      }),
    ).toBe(true);
  });

  it("below the minimum is not usable (even if only one of cols/rows)", () => {
    expect(
      isUsableTerminalSize({
        cols: MIN_TERMINAL_COLS - 1,
        rows: MIN_TERMINAL_ROWS,
      }),
    ).toBe(false);
    expect(
      isUsableTerminalSize({
        cols: MIN_TERMINAL_COLS,
        rows: MIN_TERMINAL_ROWS - 1,
      }),
    ).toBe(false);
  });

  it("rejects proposeDimensions' transient garbage (tiny actual sizes)", () => {
    expect(isUsableTerminalSize({ cols: 5, rows: 3 })).toBe(false);
    expect(isUsableTerminalSize({ cols: 1, rows: 1 })).toBe(false);
  });

  it("non-integers and values <= 0 are not usable", () => {
    expect(isUsableTerminalSize({ cols: 80.5, rows: 24 })).toBe(false);
    expect(isUsableTerminalSize({ cols: 0, rows: 0 })).toBe(false);
    expect(isUsableTerminalSize({ cols: -1, rows: 24 })).toBe(false);
  });
});

describe("clampTerminalSize", () => {
  it("at or above the minimum passes through unchanged (clamped=false)", () => {
    expect(clampTerminalSize({ cols: 80, rows: 24 })).toEqual({
      cols: 80,
      rows: 24,
      clamped: false,
    });
    expect(
      clampTerminalSize({ cols: MIN_TERMINAL_COLS, rows: MIN_TERMINAL_ROWS }),
    ).toEqual({
      cols: MIN_TERMINAL_COLS,
      rows: MIN_TERMINAL_ROWS,
      clamped: false,
    });
  });

  it("raises tiny values up to the minimum (clamped=true)", () => {
    expect(clampTerminalSize({ cols: 5, rows: 3 })).toEqual({
      cols: MIN_TERMINAL_COLS,
      rows: MIN_TERMINAL_ROWS,
      clamped: true,
    });
  });

  it("clamps even when only one side is too small", () => {
    expect(clampTerminalSize({ cols: 19, rows: 40 })).toEqual({
      cols: MIN_TERMINAL_COLS,
      rows: 40,
      clamped: true,
    });
    expect(clampTerminalSize({ cols: 100, rows: 2 })).toEqual({
      cols: 100,
      rows: MIN_TERMINAL_ROWS,
      clamped: true,
    });
  });

  it("truncates non-integers", () => {
    expect(clampTerminalSize({ cols: 143.9, rows: 40 })).toEqual({
      cols: 143,
      rows: 40,
      clamped: true,
    });
  });
});

// Pins down the core invariant as properties. In owned, all size inputs to term.open /
// term.resize pass through clampTerminalSize on the server and become settled sizes, so
// "the terminal never collapses into an unusable state" reduces to the two properties
// below for arbitrary input.
describe("clampTerminalSize invariants", () => {
  const samples = [0, 1, 2, 4, 5, 6, 19, 20, 21, 24, 80, 143, 100000];

  it("the clamp result for any input is always usable (never collapses the terminal)", () => {
    for (const cols of samples) {
      for (const rows of samples) {
        const clamped = clampTerminalSize({ cols, rows });
        expect(
          isUsableTerminalSize({ cols: clamped.cols, rows: clamped.rows }),
        ).toBe(true);
      }
    }
  });

  it("clamping is idempotent (does not drift under repeated application across paths)", () => {
    for (const cols of samples) {
      for (const rows of samples) {
        const once = clampTerminalSize({ cols, rows });
        expect(clampTerminalSize({ cols: once.cols, rows: once.rows })).toEqual(
          { cols: once.cols, rows: once.rows, clamped: false },
        );
      }
    }
  });
});
