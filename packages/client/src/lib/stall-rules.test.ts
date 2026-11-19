import { DEFAULT_STALL_RULES } from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import {
  loadStallRules,
  STALL_RULES_KEY,
  sanitizeStallRules,
  saveStallRules,
} from "./stall-rules.js";

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("stall rules persistence", () => {
  it("defaults to 20 min launch, 5 min quiet, 5 repeats, no overrides", () => {
    expect(loadStallRules(fakeStorage())).toEqual(DEFAULT_STALL_RULES);
    expect(DEFAULT_STALL_RULES).toEqual({
      launchLimitMin: 20,
      quietLimitMin: 5,
      repeatLimit: 5,
      overrides: [],
    });
  });

  it("round-trips through storage", () => {
    const storage = fakeStorage();
    const rules = {
      launchLimitMin: 30,
      quietLimitMin: 10,
      repeatLimit: 8,
      overrides: [{ match: "make ci", launchLimitMin: 25 }],
    };
    saveStallRules(storage, rules);
    expect(loadStallRules(storage)).toEqual(rules);
  });

  it("falls back to the default for a broken or foreign value", () => {
    expect(loadStallRules(fakeStorage({ [STALL_RULES_KEY]: "{oops" }))).toEqual(
      DEFAULT_STALL_RULES,
    );
    expect(loadStallRules(fakeStorage({ [STALL_RULES_KEY]: "42" }))).toEqual(
      DEFAULT_STALL_RULES,
    );
  });

  it("keeps valid fields and drops invalid ones field by field", () => {
    expect(
      sanitizeStallRules({
        launchLimitMin: 0,
        quietLimitMin: 7,
        repeatLimit: 2.5,
        overrides: [
          { match: " make ci ", launchLimitMin: 25 },
          { match: "", launchLimitMin: 10 },
          { match: "x", launchLimitMin: -1 },
          "junk",
        ],
      }),
    ).toEqual({
      launchLimitMin: 20,
      quietLimitMin: 7,
      repeatLimit: 5,
      overrides: [{ match: "make ci", launchLimitMin: 25 }],
    });
  });

  it("survives a storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadStallRules(throwing)).toEqual(DEFAULT_STALL_RULES);
    expect(() => saveStallRules(throwing, DEFAULT_STALL_RULES)).not.toThrow();
  });
});
