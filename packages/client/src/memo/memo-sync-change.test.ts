import { describe, expect, it } from "vitest";

import { keepThroughSync, memoSyncChange } from "./memo-sync-change.js";

describe("memoSyncChange", () => {
  it("is null when nothing changed", () => {
    expect(memoSyncChange("same", "same")).toBeNull();
  });

  it("replaces only the span between the common prefix and suffix", () => {
    expect(memoSyncChange("one two three", "one 2 three")).toEqual({
      from: 4,
      to: 7,
      insert: "2",
    });
  });

  it("is a pure insertion when text was appended", () => {
    expect(memoSyncChange("a\nb", "a\nb\nc")).toEqual({
      from: 3,
      to: 3,
      insert: "\nc",
    });
  });

  it("does not let the prefix and suffix overlap on repeated characters", () => {
    expect(memoSyncChange("aaa", "aaaa")).toEqual({
      from: 3,
      to: 3,
      insert: "a",
    });
    expect(memoSyncChange("aaaa", "aa")).toEqual({
      from: 2,
      to: 4,
      insert: "",
    });
  });

  it("never splits a surrogate pair at either edge", () => {
    expect(memoSyncChange("a😀b", "a😁b")).toEqual({
      from: 1,
      to: 3,
      insert: "😁",
    });
  });

  it("replaces everything when nothing is shared", () => {
    expect(memoSyncChange("abc", "xyz")).toEqual({
      from: 0,
      to: 3,
      insert: "xyz",
    });
  });
});

describe("keepThroughSync", () => {
  const change = { from: 4, to: 7, insert: "12345" };

  it("leaves a position before the change alone", () => {
    expect(keepThroughSync(2, change)).toBe(2);
    expect(keepThroughSync(4, change)).toBe(4);
  });

  it("shifts a position after the change by the change's growth", () => {
    expect(keepThroughSync(7, change)).toBe(9);
    expect(keepThroughSync(10, change)).toBe(12);
  });

  it("keeps a position inside the change at its offset, clamped to the inserted text", () => {
    expect(keepThroughSync(6, change)).toBe(6);
    expect(keepThroughSync(6, { from: 0, to: 10, insert: "ab" })).toBe(2);
  });

  it("never lands between the halves of an inserted surrogate pair", () => {
    expect(keepThroughSync(2, { from: 1, to: 3, insert: "😀" })).toBe(1);
  });
});
