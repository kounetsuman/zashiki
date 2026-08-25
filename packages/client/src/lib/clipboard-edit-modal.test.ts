import { describe, expect, it } from "vitest";

import {
  CLIPBOARD_EDIT_MODAL_KEY,
  loadClipboardEditEnabled,
  saveClipboardEditEnabled,
  shouldOpenClipboardEditModal,
  trimLineEndWhitespace,
} from "./clipboard-edit-modal.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: (k: string) => map.get(k) ?? null,
  };
}

describe("loadClipboardEditEnabled", () => {
  it("defaults to on when unset", () => {
    expect(loadClipboardEditEnabled(fakeStorage())).toBe(true);
  });

  it("defaults to on when storage is null", () => {
    expect(loadClipboardEditEnabled(null)).toBe(true);
  });

  it("is off only for the explicit '0'", () => {
    expect(
      loadClipboardEditEnabled(
        fakeStorage({ [CLIPBOARD_EDIT_MODAL_KEY]: "0" }),
      ),
    ).toBe(false);
    expect(
      loadClipboardEditEnabled(
        fakeStorage({ [CLIPBOARD_EDIT_MODAL_KEY]: "1" }),
      ),
    ).toBe(true);
  });
});

describe("saveClipboardEditEnabled", () => {
  it("persists as '1'/'0'", () => {
    const s = fakeStorage();
    saveClipboardEditEnabled(s, false);
    expect(s.read(CLIPBOARD_EDIT_MODAL_KEY)).toBe("0");
    saveClipboardEditEnabled(s, true);
    expect(s.read(CLIPBOARD_EDIT_MODAL_KEY)).toBe("1");
  });
});

describe("shouldOpenClipboardEditModal", () => {
  it("opens only when enabled and the selection has a newline", () => {
    expect(shouldOpenClipboardEditModal(true, "a\nb")).toBe(true);
    expect(shouldOpenClipboardEditModal(true, "single line")).toBe(false);
    expect(shouldOpenClipboardEditModal(true, "")).toBe(false);
    expect(shouldOpenClipboardEditModal(false, "a\nb")).toBe(false);
  });
});

describe("trimLineEndWhitespace", () => {
  it("drops trailing spaces and tabs from each line", () => {
    expect(trimLineEndWhitespace("claude   \n  --flag\t\n")).toBe(
      "claude\n  --flag\n",
    );
  });

  it("keeps leading indentation and the newlines themselves", () => {
    expect(trimLineEndWhitespace("  a  \n\n  b")).toBe("  a\n\n  b");
  });

  it("leaves clean text unchanged", () => {
    expect(trimLineEndWhitespace("claude \\\n  --flag")).toBe(
      "claude \\\n  --flag",
    );
  });
});
