import { describe, expect, it } from "vitest";

import {
  IDLE_THRESHOLD_MS,
  IDLE_WARNING_SHOWN_DAY_KEY,
  idleDays,
  idleTerminalRows,
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

describe("idleTerminalRows", () => {
  const terminal = (id: string) => ({
    cockpitTerminalId: id,
    name: id,
    org: "org",
    repo: "repo",
    state: "idle" as const,
    title: null,
    active: false,
  });
  const idle = new Map([
    ["b", NOW - 30 * HOUR],
    ["a", NOW - 48 * HOUR],
  ]);

  it("follows the list order and labels each row", () => {
    const rows = idleTerminalRows(
      idle,
      [terminal("a"), terminal("x"), terminal("b")],
      (t) => `label-${t.name}`,
    );
    expect(rows.map((r) => [r.title, r.lastActivityAt])).toEqual([
      ["label-a", NOW - 48 * HOUR],
      ["label-b", NOW - 30 * HOUR],
    ]);
  });

  it("drops a terminal that is no longer listed, down to nothing", () => {
    expect(
      idleTerminalRows(idle, [terminal("b")], (t) => t.name).map(
        (r) => r.terminal.cockpitTerminalId,
      ),
    ).toEqual(["b"]);
    expect(idleTerminalRows(idle, [], (t) => t.name)).toEqual([]);
  });

  it("has no rows while the warning is not up", () => {
    expect(idleTerminalRows(null, [terminal("a")], (t) => t.name)).toEqual([]);
  });
});
