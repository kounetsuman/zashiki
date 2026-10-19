import { describe, expect, it } from "vitest";

import {
  IDLE_THRESHOLD_MS,
  IDLE_WARNING_SHOWN_DAY_KEY,
  idleDays,
  idleTerminals,
  loadIdleWarningShownDay,
  saveIdleWarningShownDay,
} from "./idle-terminal-warning.js";

const NOW = Date.UTC(2026, 9, 20, 12);
const HOUR = 60 * 60 * 1000;

describe("idleTerminals", () => {
  it("keeps only the terminals without activity for the threshold or longer", () => {
    const idle = idleTerminals(
      {
        terminals: [
          { cockpitTerminalId: "a", lastActivityAt: NOW - IDLE_THRESHOLD_MS },
          { cockpitTerminalId: "b", lastActivityAt: NOW - 23 * HOUR },
          { cockpitTerminalId: "c", lastActivityAt: NOW - 72 * HOUR },
        ],
      },
      NOW,
    );
    expect([...idle]).toEqual([
      ["a", NOW - IDLE_THRESHOLD_MS],
      ["c", NOW - 72 * HOUR],
    ]);
  });
});

describe("idleDays", () => {
  it("counts whole days", () => {
    expect(idleDays(NOW - 24 * HOUR, NOW)).toBe(1);
    expect(idleDays(NOW - 71 * HOUR, NOW)).toBe(2);
  });
});

describe("shown day storage", () => {
  it("round-trips the day", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    expect(loadIdleWarningShownDay(storage)).toBeNull();
    saveIdleWarningShownDay(storage, "2026-10-20");
    expect(map.get(IDLE_WARNING_SHOWN_DAY_KEY)).toBe("2026-10-20");
    expect(loadIdleWarningShownDay(storage)).toBe("2026-10-20");
  });

  it("treats a throwing storage as never shown", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadIdleWarningShownDay(storage)).toBeNull();
    expect(() => saveIdleWarningShownDay(storage, "2026-10-20")).not.toThrow();
  });
});
