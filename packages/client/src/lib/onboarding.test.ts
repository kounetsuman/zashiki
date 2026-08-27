import { describe, expect, it } from "vitest";

import { loadOnboardingSeen, saveOnboardingSeen } from "./onboarding.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("welcome onboarding seen flag", () => {
  it("treats a fresh install (no key) as a first run, then remembers it", () => {
    const s = memoryStorage();
    expect(loadOnboardingSeen(s)).toBe(false);
    saveOnboardingSeen(s);
    // A later launch (including after an app update) reads the persisted key and is not re-greeted.
    expect(loadOnboardingSeen(s)).toBe(true);
  });

  it("defaults to not-seen without storage", () => {
    expect(loadOnboardingSeen(null)).toBe(false);
  });
});
