import { describe, expect, it } from "vitest";

import { memoStatus } from "./memo-status.js";

const caret = { line: 5, col: 3 };

describe("memoStatus", () => {
  it("reports the caret position when nothing is selected", () => {
    expect(memoStatus(caret, [])).toEqual({ kind: "cursor", line: 5, col: 3 });
  });

  it("reports the caret position when every range is empty (multi-caret)", () => {
    const ranges = [
      { length: 0, fromLine: 2, toLine: 2, endsAtLineStart: false },
      { length: 0, fromLine: 5, toLine: 5, endsAtLineStart: false },
    ];
    expect(memoStatus(caret, ranges)).toEqual({
      kind: "cursor",
      line: 5,
      col: 3,
    });
  });

  it("counts characters and lines for a selection within one line", () => {
    const ranges = [
      { length: 5, fromLine: 2, toLine: 2, endsAtLineStart: false },
    ];
    expect(memoStatus(caret, ranges)).toEqual({
      kind: "selection",
      lines: 1,
      chars: 5,
    });
  });

  it("counts every line a multi-line selection touches", () => {
    const ranges = [
      { length: 40, fromLine: 3, toLine: 5, endsAtLineStart: false },
    ];
    expect(memoStatus(caret, ranges)).toEqual({
      kind: "selection",
      lines: 3,
      chars: 40,
    });
  });

  it("drops the trailing line when the selection ends at a line start", () => {
    const ranges = [
      { length: 12, fromLine: 3, toLine: 4, endsAtLineStart: true },
    ];
    expect(memoStatus(caret, ranges)).toEqual({
      kind: "selection",
      lines: 1,
      chars: 12,
    });
  });

  it("sums characters and lines across multiple selections", () => {
    const ranges = [
      { length: 5, fromLine: 1, toLine: 1, endsAtLineStart: false },
      { length: 20, fromLine: 4, toLine: 5, endsAtLineStart: false },
    ];
    expect(memoStatus(caret, ranges)).toEqual({
      kind: "selection",
      lines: 3,
      chars: 25,
    });
  });

  it("counts a physical line once when multiple selections share it", () => {
    const ranges = [
      { length: 2, fromLine: 3, toLine: 3, endsAtLineStart: false },
      { length: 4, fromLine: 3, toLine: 4, endsAtLineStart: false },
    ];
    expect(memoStatus(caret, ranges)).toEqual({
      kind: "selection",
      lines: 2,
      chars: 6,
    });
  });
});
