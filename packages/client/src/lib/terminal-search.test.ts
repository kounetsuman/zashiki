import { describe, expect, it } from "vitest";

import {
  buildSearchOptions,
  centerScrollTop,
  matchCounter,
} from "./terminal-search.js";

describe("matchCounter", () => {
  it("is null while the query is empty (nothing to count yet)", () => {
    expect(matchCounter("", { resultIndex: -1, resultCount: 0 })).toBeNull();
  });

  it("reports a 1-based active index against the total", () => {
    expect(matchCounter("foo", { resultIndex: 2, resultCount: 12 })).toEqual({
      current: 3,
      total: 12,
    });
  });

  it("reports current 0 when there is no active match", () => {
    expect(matchCounter("foo", { resultIndex: -1, resultCount: 0 })).toEqual({
      current: 0,
      total: 0,
    });
  });
});

describe("centerScrollTop", () => {
  it("places the match (1-based y) at the vertical center of the viewport", () => {
    // match on buffer line 100 (1-based) => 0-based 99, rows 24 => top = 99 - 12 = 87
    expect(centerScrollTop(100, 24)).toBe(87);
  });

  it("clamps at the top so an early match does not scroll above line 0", () => {
    expect(centerScrollTop(2, 24)).toBe(0);
  });
});

describe("buildSearchOptions", () => {
  it("always enables highlight decorations and forwards the incremental flag", () => {
    expect(buildSearchOptions(true).incremental).toBe(true);
    expect(buildSearchOptions(false).incremental).toBe(false);
    expect(buildSearchOptions(true).decorations).toBeDefined();
  });
});
