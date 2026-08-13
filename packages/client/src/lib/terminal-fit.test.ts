import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import { isValidSize, shouldSendResize } from "./terminal-fit.js";

describe("shouldSendResize", () => {
  it("sends when cols/rows change", () => {
    expect(
      shouldSendResize({ cols: 61, rows: 24 }, { cols: 143, rows: 24 }),
    ).toBe(true);
    expect(
      shouldSendResize({ cols: 80, rows: 24 }, { cols: 80, rows: 40 }),
    ).toBe(true);
  });

  it("does not send when cols/rows are unchanged (suppresses no-op sends)", () => {
    expect(
      shouldSendResize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }),
    ).toBe(false);
  });

  it("does not send invalid dimensions (<= 0 or NaN) for a fit with undetermined cells", () => {
    expect(
      shouldSendResize({ cols: 80, rows: 24 }, { cols: 0, rows: 24 }),
    ).toBe(false);
    expect(
      shouldSendResize({ cols: 80, rows: 24 }, { cols: 143, rows: 0 }),
    ).toBe(false);
    expect(
      shouldSendResize({ cols: 80, rows: 24 }, { cols: Number.NaN, rows: 24 }),
    ).toBe(false);
  });

  it("does not send undersized actual dimensions (tiny fit mid-layout)", () => {
    expect(shouldSendResize({ cols: 80, rows: 24 }, { cols: 5, rows: 3 })).toBe(
      false,
    );
    expect(
      shouldSendResize(
        { cols: 80, rows: 24 },
        { cols: MIN_TERMINAL_COLS - 1, rows: 24 },
      ),
    ).toBe(false);
  });
});

describe("isValidSize", () => {
  it("only positive integers are valid", () => {
    expect(isValidSize({ cols: 143, rows: 40 })).toBe(true);
    expect(isValidSize({ cols: 0, rows: 24 })).toBe(false);
    expect(isValidSize({ cols: 80, rows: -1 })).toBe(false);
    expect(isValidSize({ cols: 1.5, rows: 24 })).toBe(false);
    expect(isValidSize({ cols: Number.NaN, rows: 24 })).toBe(false);
  });

  it("tiny actual dimensions below the practical minimum are invalid", () => {
    expect(isValidSize({ cols: 5, rows: 3 })).toBe(false);
    expect(isValidSize({ cols: MIN_TERMINAL_COLS - 1, rows: 40 })).toBe(false);
    expect(isValidSize({ cols: 80, rows: MIN_TERMINAL_ROWS - 1 })).toBe(false);
    expect(
      isValidSize({ cols: MIN_TERMINAL_COLS, rows: MIN_TERMINAL_ROWS }),
    ).toBe(true);
  });
});
