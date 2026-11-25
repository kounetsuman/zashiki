import { describe, expect, it } from "vitest";

import { locateMatches, stepMatchIndex } from "./preview-search.js";

describe("locateMatches", () => {
  it("finds every case-insensitive match inside one segment", () => {
    expect(locateMatches(["Foo bar foo"], "foo")).toEqual([
      { start: { segment: 0, offset: 0 }, end: { segment: 0, offset: 3 } },
      { start: { segment: 0, offset: 8 }, end: { segment: 0, offset: 11 } },
    ]);
  });

  it("finds a match that spans adjacent segments (text split by inline markup)", () => {
    expect(locateMatches(["say ", "hello", " world"], "hello wor")).toEqual([
      { start: { segment: 1, offset: 0 }, end: { segment: 2, offset: 4 } },
    ]);
  });

  it("ends a match that stops at a segment boundary inside that segment", () => {
    expect(locateMatches(["ab", "cd"], "ab")).toEqual([
      { start: { segment: 0, offset: 0 }, end: { segment: 0, offset: 2 } },
    ]);
  });

  it("treats the query literally, not as a regular expression", () => {
    expect(locateMatches(["a.b axb"], "a.b")).toHaveLength(1);
    expect(locateMatches(["(x)"], "(x")).toHaveLength(1);
  });

  it("finds nothing for an empty query", () => {
    expect(locateMatches(["anything"], "")).toEqual([]);
  });

  it("does not overlap matches", () => {
    expect(locateMatches(["aaaa"], "aa")).toHaveLength(2);
  });
});

describe("stepMatchIndex", () => {
  it("moves forward and wraps past the last match", () => {
    expect(stepMatchIndex(0, 3, "next")).toBe(1);
    expect(stepMatchIndex(2, 3, "next")).toBe(0);
  });

  it("moves backward and wraps before the first match", () => {
    expect(stepMatchIndex(1, 3, "previous")).toBe(0);
    expect(stepMatchIndex(0, 3, "previous")).toBe(2);
  });

  it("has no active match when there are none", () => {
    expect(stepMatchIndex(0, 0, "next")).toBe(-1);
  });
});
