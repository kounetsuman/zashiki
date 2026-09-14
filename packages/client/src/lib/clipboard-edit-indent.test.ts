import { describe, expect, it } from "vitest";

import {
  DEFAULT_INDENT_SETTING,
  type IndentSetting,
  indentUnit,
  loadIndentSetting,
  saveIndentSetting,
} from "./clipboard-edit-indent.js";

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
