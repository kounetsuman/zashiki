import { describe, expect, it } from "vitest";

import en from "./locales/en.json";
import ja from "./locales/ja.json";

// Guards that the ja / en key sets match exactly.
// Mechanically detects missing translations, key typos, and extra keys in added-language resources.

type Tree = { [k: string]: string | Tree };

function flattenKeys(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "string" ? [path] : flattenKeys(value, path);
  });
}

/** The set of `{{name}}` interpolation variables (unordered, deduplicated). */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "").sort();
}

function leaves(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, leaves(value, path));
  }
  return out;
}

describe("locales parity (ja / en)", () => {
  it("ja and en key sets match exactly (no missing translations or extra keys)", () => {
    const jaKeys = flattenKeys(ja as Tree).sort();
    const enKeys = flattenKeys(en as Tree).sort();
    expect(enKeys).toEqual(jaKeys);
  });

  it("interpolation variables {{...}} match between ja and en for the same key", () => {
    const jaLeaves = leaves(ja as Tree);
    const enLeaves = leaves(en as Tree);
    const mismatches = Object.keys(jaLeaves)
      .filter((k) => enLeaves[k] !== undefined)
      .filter(
        (k) =>
          placeholders(jaLeaves[k] ?? "").join(",") !==
          placeholders(enLeaves[k] ?? "").join(","),
      );
    expect(mismatches, `補間変数が不一致: ${mismatches.join(", ")}`).toEqual(
      [],
    );
  });
});
