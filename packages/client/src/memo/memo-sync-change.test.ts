import { describe, expect, it } from "vitest";

import { type MemoSyncChange, memoSyncChanges } from "./memo-sync-change.js";

function apply(text: string, changes: MemoSyncChange[]): string {
  return changes.reduceRight(
    (acc, { from, to, insert }) => acc.slice(0, from) + insert + acc.slice(to),
    text,
  );
}

describe("memoSyncChanges", () => {
  it("is empty when nothing changed", () => {
    expect(memoSyncChanges("same", "same")).toEqual([]);
  });

  it("turns the current text into the incoming text", () => {
    const current = "one two three\nfour";
    const incoming = "zero one 2 three\nfour five";
    expect(apply(current, memoSyncChanges(current, incoming))).toBe(incoming);
  });

  it("leaves the unchanged text between two distant edits untouched", () => {
    const middle = "untouched middle";
    const current = `A\n${middle}\nZ`;
    const changes = memoSyncChanges(current, `AAAA\n${middle}\nZZ`);
    const middleStart = current.indexOf(middle);
    const middleEnd = middleStart + middle.length;
    expect(changes).toHaveLength(2);
    for (const { from, to } of changes)
      expect(to <= middleStart || from >= middleEnd).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    for (const { from, to } of memoSyncChanges("a😀b", "a😁b"))
      for (const edge of [from, to]) {
        const code = "a😀b".charCodeAt(edge);
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
  });
});
