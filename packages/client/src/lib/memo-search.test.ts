import { describe, expect, it } from "vitest";

import { memoMatchLabel, memoMatchStats } from "./memo-search.js";

describe("memoMatchStats", () => {
  it("counts matches and finds the 1-based index of the selected one", () => {
    const matches = [
      { from: 0, to: 3 },
      { from: 10, to: 13 },
      { from: 20, to: 23 },
    ];
    expect(memoMatchStats(matches, { from: 10, to: 13 })).toEqual({
      current: 2,
      total: 3,
    });
  });

  it("reports current 0 when the selection is not on any match", () => {
    const matches = [
      { from: 0, to: 3 },
      { from: 10, to: 13 },
    ];
    expect(memoMatchStats(matches, { from: 5, to: 5 })).toEqual({
      current: 0,
      total: 2,
    });
  });

  it("is empty when there are no matches", () => {
    expect(memoMatchStats([], { from: 0, to: 0 })).toEqual({
      current: 0,
      total: 0,
    });
  });
});

describe("memoMatchLabel", () => {
  it("is blank while the query is empty (nothing to count yet)", () => {
    expect(memoMatchLabel("", { current: 0, total: 0 }, "No results")).toBe("");
  });

  it("shows the no-matches text when the query finds nothing", () => {
    expect(memoMatchLabel("foo", { current: 0, total: 0 }, "No results")).toBe(
      "No results",
    );
  });

  it("shows current / total when there are matches", () => {
    expect(memoMatchLabel("foo", { current: 2, total: 3 }, "No results")).toBe(
      "2 / 3",
    );
  });
});
