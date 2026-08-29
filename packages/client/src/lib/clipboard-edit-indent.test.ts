import { describe, expect, it } from "vitest";

import {
  DEFAULT_INDENT_SETTING,
  type IndentSetting,
  indentSelection,
  indentUnit,
  loadIndentSetting,
  outdentSelection,
  saveIndentSetting,
} from "./clipboard-edit-indent.js";

const SPACES2: IndentSetting = { useTab: false, spaceCount: 2 };
const SPACES4: IndentSetting = { useTab: false, spaceCount: 4 };
const TAB: IndentSetting = { useTab: true, spaceCount: 2 };

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("indentUnit", () => {
  it("is a tab in tab mode and N spaces in space mode", () => {
    expect(indentUnit(TAB)).toBe("\t");
    expect(indentUnit(SPACES4)).toBe("    ");
  });
});

describe("indentSelection", () => {
  it("prepends the unit to every line the selection touches", () => {
    const out = indentSelection(
      { value: "a\nb\nc", start: 0, end: 5 },
      SPACES2,
    );
    expect(out.value).toBe("  a\n  b\n  c");
  });

  it("keeps a full selection covering the indented block (start stays at column 0)", () => {
    const out = indentSelection({ value: "a\nb", start: 0, end: 3 }, SPACES2);
    expect(out.value).toBe("  a\n  b");
    expect([out.start, out.end]).toEqual([0, 7]);
  });

  it("does not indent a trailing line that only the selection's newline reaches", () => {
    const out = indentSelection(
      { value: "a\nb\nc", start: 0, end: 2 },
      SPACES2,
    );
    expect(out.value).toBe("  a\nb\nc");
  });

  it("indents only the touched lines for a mid-block selection", () => {
    const out = indentSelection({ value: "a\nb\nc\nd", start: 2, end: 5 }, TAB);
    expect(out.value).toBe("a\n\tb\n\tc\nd");
  });

  it("inserts the unit at the caret when there is no selection", () => {
    const out = indentSelection({ value: "ab", start: 1, end: 1 }, SPACES2);
    expect(out.value).toBe("a  b");
    expect([out.start, out.end]).toEqual([3, 3]);
  });
});

describe("outdentSelection", () => {
  it("removes up to N leading spaces from each selected line", () => {
    const out = outdentSelection(
      { value: "    a\n  b\nc", start: 0, end: 10 },
      SPACES2,
    );
    expect(out.value).toBe("  a\nb\nc");
  });

  it("removes a single leading tab regardless of the space width", () => {
    const out = outdentSelection(
      { value: "\ta\n\tb", start: 0, end: 5 },
      SPACES4,
    );
    expect(out.value).toBe("a\nb");
  });

  it("is a no-op on lines with no leading whitespace", () => {
    const out = outdentSelection({ value: "a\nb", start: 0, end: 3 }, SPACES2);
    expect(out.value).toBe("a\nb");
    expect([out.start, out.end]).toEqual([0, 3]);
  });

  it("outdents the caret's line when there is no selection", () => {
    const out = outdentSelection(
      { value: "a\n    b\nc", start: 6, end: 6 },
      SPACES2,
    );
    expect(out.value).toBe("a\n  b\nc");
  });
});

describe("indent setting persistence", () => {
  it("defaults to spaces of width 2 when storage is empty", () => {
    expect(loadIndentSetting(fakeStorage())).toEqual(DEFAULT_INDENT_SETTING);
    expect(DEFAULT_INDENT_SETTING).toEqual({ useTab: false, spaceCount: 2 });
  });

  it("round-trips through storage", () => {
    const storage = fakeStorage();
    saveIndentSetting(storage, { useTab: true, spaceCount: 4 });
    expect(loadIndentSetting(storage)).toEqual({ useTab: true, spaceCount: 4 });
  });

  it("clamps an out-of-range or malformed space count to the default", () => {
    expect(
      loadIndentSetting(
        fakeStorage({ "zk.clipboardEdit.indentSpaceCount": "0" }),
      ).spaceCount,
    ).toBe(1);
    expect(
      loadIndentSetting(
        fakeStorage({ "zk.clipboardEdit.indentSpaceCount": "99" }),
      ).spaceCount,
    ).toBe(8);
    expect(
      loadIndentSetting(
        fakeStorage({ "zk.clipboardEdit.indentSpaceCount": "x" }),
      ).spaceCount,
    ).toBe(2);
  });

  it("tolerates a null storage", () => {
    expect(loadIndentSetting(null)).toEqual(DEFAULT_INDENT_SETTING);
    expect(() => saveIndentSetting(null, DEFAULT_INDENT_SETTING)).not.toThrow();
  });
});
