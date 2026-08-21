import { describe, expect, it } from "vitest";

import {
  loadFirstRunWizardSeen,
  saveFirstRunWizardSeen,
  shouldShowFirstRunWizard,
} from "./first-run-wizard.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("first-run wizard dismissal", () => {
  it("round-trips the seen flag", () => {
    const s = memoryStorage();
    expect(loadFirstRunWizardSeen(s)).toBe(false);
    saveFirstRunWizardSeen(s);
    expect(loadFirstRunWizardSeen(s)).toBe(true);
  });

  it("defaults to not-seen without storage", () => {
    expect(loadFirstRunWizardSeen(null)).toBe(false);
  });
});

describe("shouldShowFirstRunWizard", () => {
  const unregistered = { hooksRegistered: false, statusLineRegistered: false };
  const registered = { hooksRegistered: true, statusLineRegistered: true };

  it("hides until the status has arrived", () => {
    expect(shouldShowFirstRunWizard(false, null)).toBe(false);
  });

  it("shows when unregistered and not yet dismissed", () => {
    expect(shouldShowFirstRunWizard(false, unregistered)).toBe(true);
  });

  it("shows when only partially registered", () => {
    expect(
      shouldShowFirstRunWizard(false, {
        hooksRegistered: true,
        statusLineRegistered: false,
      }),
    ).toBe(true);
  });

  it("hides once fully registered", () => {
    expect(shouldShowFirstRunWizard(false, registered)).toBe(false);
  });

  it("hides once dismissed", () => {
    expect(shouldShowFirstRunWizard(true, unregistered)).toBe(false);
  });
});
