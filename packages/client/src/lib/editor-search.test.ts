import { describe, expect, it } from "vitest";

import { matchLabel, matchStats } from "./editor-search.js";

describe("matchStats", () => {
  it("counts matches and finds the 1-based index of the selected one", () => {
    const matches = [
      { from: 0, to: 3 },
      { from: 10, to: 13 },
      { from: 20, to: 23 },
    ];
    expect(matchStats(matches, { from: 10, to: 13 })).toEqual({
      current: 2,
      total: 3,
    });
  });

  it("reports current 0 when the selection is not on any match", () => {
    const matches = [
      { from: 0, to: 3 },
      { from: 10, to: 13 },
    ];
    expect(matchStats(matches, { from: 5, to: 5 })).toEqual({
      current: 0,
      total: 2,
    });
  });

  it("is empty when there are no matches", () => {
    expect(matchStats([], { from: 0, to: 0 })).toEqual({
      current: 0,
      total: 0,
    });
  });
});

describe("matchLabel", () => {
  it("is blank while the query is empty (nothing to count yet)", () => {
    expect(matchLabel("", { current: 0, total: 0 }, "No results")).toBe("");
  });

  it("shows the no-matches text when the query finds nothing", () => {
    expect(matchLabel("foo", { current: 0, total: 0 }, "No results")).toBe(
      "No results",
    );
  });

  it("shows current / total when there are matches", () => {
    expect(matchLabel("foo", { current: 2, total: 3 }, "No results")).toBe(
      "2 / 3",
    );
  });
});
