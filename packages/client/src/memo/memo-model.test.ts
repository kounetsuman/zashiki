import { describe, expect, it } from "vitest";

import {
  confirmMemoSaved,
  EMPTY_MEMO,
  editMemo,
  type MemoBuffer,
  memoDirty,
  syncMemo,
} from "./memo-model.js";

const buf = (text: string, savedText: string): MemoBuffer => ({
  text,
  savedText,
});

describe("memoDirty", () => {
  it("is clean when text matches the saved baseline", () => {
    expect(memoDirty(EMPTY_MEMO)).toBe(false);
    expect(memoDirty(buf("hi", "hi"))).toBe(false);
  });

  it("is dirty when the editor text diverges from the saved baseline", () => {
    expect(memoDirty(buf("hi there", "hi"))).toBe(true);
  });

  it("treats whitespace-only text as clean against an empty baseline (the server stores blank as empty)", () => {
    expect(memoDirty(buf("   \n", ""))).toBe(false);
  });
});

describe("editMemo", () => {
  it("moves the editor text and marks the buffer dirty", () => {
    const r = editMemo(buf("hi", "hi"), "hi there");
    expect(r).toEqual(buf("hi there", "hi"));
    expect(memoDirty(r)).toBe(true);
  });

  it("is a no-op (same reference) when the text is unchanged", () => {
    const base = buf("hi", "hi");
    expect(editMemo(base, "hi")).toBe(base);
  });
});

describe("syncMemo", () => {
  it("adopts the server text wholesale when there are no local edits", () => {
    const r = syncMemo(buf("old", "old"), "fresh");
    expect(r).toEqual(buf("fresh", "fresh"));
    expect(memoDirty(r)).toBe(false);
  });

  it("keeps in-progress local edits and only re-bases the saved baseline", () => {
    const r = syncMemo(buf("my draft", "old"), "remote");
    expect(r).toEqual(buf("my draft", "remote"));
    expect(memoDirty(r)).toBe(true);
  });

  it("becomes clean when a remote change happens to equal the local draft", () => {
    const r = syncMemo(buf("same", "old"), "same");
    expect(memoDirty(r)).toBe(false);
  });

  it("is a no-op (same reference) when nothing changes", () => {
    const base = buf("hi", "hi");
    expect(syncMemo(base, "hi")).toBe(base);
  });

  it("settles a whitespace-only save to clean once the server echoes empty", () => {
    // Dirty whitespace-only buffer; the server stored it as empty and echoes "".
    const r = syncMemo(buf("   ", "old"), "");
    expect(memoDirty(r)).toBe(false);
  });

  it("keeps clean whitespace-only local text when the server echoes its empty form", () => {
    const base = buf("   ", "");
    expect(syncMemo(base, "")).toBe(base);
  });
});

describe("confirmMemoSaved", () => {
  it("becomes clean when the buffer still holds the saved text", () => {
    const r = confirmMemoSaved(buf("hi", ""), "hi");
    expect(r).toEqual(buf("hi", "hi"));
    expect(memoDirty(r)).toBe(false);
  });

  it("keeps edits typed after the save dirty against the new baseline", () => {
    const r = confirmMemoSaved(buf("hi and more", ""), "hi");
    expect(r).toEqual(buf("hi and more", "hi"));
    expect(memoDirty(r)).toBe(true);
  });

  it("records a whitespace-only save as the empty baseline (the server deletes it)", () => {
    const r = confirmMemoSaved(buf("   ", "old"), "   ");
    expect(r.savedText).toBe("");
    expect(memoDirty(r)).toBe(false);
  });

  it("never replaces the editor text: a stale confirmation leaves the buffer dirty", () => {
    // The buffer already advanced to newer text when an older save's confirmation lands.
    const r = confirmMemoSaved(buf("newer", "newer"), "older");
    expect(r).toEqual(buf("newer", "older"));
    expect(memoDirty(r)).toBe(true);
  });
});
