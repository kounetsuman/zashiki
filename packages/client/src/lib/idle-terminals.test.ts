import { describe, expect, it } from "vitest";

import {
  IDLE_THRESHOLD_MS,
  idleDays,
  idleTerminalRows,
  idleTerminals,
  idleTone,
} from "./idle-terminals.js";

const NOW = Date.UTC(2026, 9, 20, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

describe("idleTone", () => {
  it("turns red from a week on", () => {
    expect(idleTone(1)).toBe("amber");
    expect(idleTone(6)).toBe("amber");
    expect(idleTone(7)).toBe("red");
    expect(idleTone(30)).toBe("red");
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
    ["b", NOW - 2 * DAY],
    ["a", NOW - 9 * DAY],
    ["c", NOW - 2 * DAY],
  ]);

  it("puts the longest-idle first, keeping list order on a tie, and labels each row", () => {
    const rows = idleTerminalRows(
      idle,
      [terminal("c"), terminal("x"), terminal("b"), terminal("a")],
      (t) => `label-${t.name}`,
    );
    expect(rows.map((r) => [r.title, r.lastActivityAt])).toEqual([
      ["label-a", NOW - 9 * DAY],
      ["label-c", NOW - 2 * DAY],
      ["label-b", NOW - 2 * DAY],
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
});
