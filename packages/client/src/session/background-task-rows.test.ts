import { type BackgroundTask, DEFAULT_STALL_RULES } from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import {
  backgroundTaskRows,
  backgroundTasksBadge,
  commandHead,
  countByFilter,
  filterRows,
  formatAgo,
  formatElapsed,
  isFilterSelected,
  liveNowMs,
  stalledCockpitTerminalIds,
  toggleFilter,
} from "./background-task-rows.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function task(over: Partial<BackgroundTask>): BackgroundTask {
  return {
    cockpitTerminalId: "t1",
    org: "o",
    repo: "r",
    cwd: "/w/r",
    sid: "s1",
    taskId: "b",
    description: "d",
    command: "c",
    startedAt: NOW - MIN,
    phase: "running",
    outputModifiedAt: NOW,
    lastLineRepeats: 0,
    ...over,
  };
}

const tasks = [
  task({
    taskId: "ended",
    phase: "ended",
    exitCode: 0,
    startedAt: NOW - 2 * MIN,
  }),
  task({ taskId: "old-run", startedAt: NOW - 3 * MIN }),
  task({ taskId: "cut", phase: "disconnected" }),
  task({ taskId: "stuck", cockpitTerminalId: "t2", startedAt: NOW - 30 * MIN }),
  task({ taskId: "new-run", startedAt: NOW - MIN }),
];

describe("backgroundTaskRows", () => {
  it("puts stalled first, then running, ended, disconnected; newest first within", () => {
    expect(
      backgroundTaskRows(tasks, NOW, DEFAULT_STALL_RULES).map(
        (r) => r.task.taskId,
      ),
    ).toEqual(["stuck", "new-run", "old-run", "ended", "cut"]);
  });

  it("counts and filters by status, and names the terminals with a stalled task", () => {
    const rows = backgroundTaskRows(tasks, NOW, DEFAULT_STALL_RULES);
    expect(countByFilter(rows)).toEqual({
      stalled: 1,
      running: 2,
      ended: 1,
      disconnected: 1,
      all: 5,
    });
    expect(
      filterRows(rows, new Set(["running"])).map((r) => r.task.taskId),
    ).toEqual(["new-run", "old-run"]);
    expect(
      filterRows(rows, new Set(["stalled", "running"])).map(
        (r) => r.task.taskId,
      ),
    ).toEqual(["stuck", "new-run", "old-run"]);
    expect(filterRows(rows, new Set())).toHaveLength(5);
    expect([...stalledCockpitTerminalIds(rows)]).toEqual(["t2"]);
  });

  it("badges the stalled tasks plus the idle terminals", () => {
    const rows = backgroundTaskRows(tasks, NOW, DEFAULT_STALL_RULES);
    expect(backgroundTasksBadge(rows, 0)).toBe(1);
    expect(backgroundTasksBadge(rows, 3)).toBe(4);
    expect(backgroundTasksBadge([], 2)).toBe(2);
  });
});

describe("toggleFilter", () => {
  it("toggles one status at a time, and All clears the selection", () => {
    const stalled = toggleFilter(new Set(), "stalled");
    expect([...stalled]).toEqual(["stalled"]);
    const both = toggleFilter(stalled, "running");
    expect([...both].sort()).toEqual(["running", "stalled"]);
    expect([...toggleFilter(both, "stalled")]).toEqual(["running"]);
    expect(toggleFilter(both, "all").size).toBe(0);
  });

  it("marks All selected only while no single status is", () => {
    expect(isFilterSelected(new Set(), "all")).toBe(true);
    expect(isFilterSelected(new Set(), "stalled")).toBe(false);
    expect(isFilterSelected(new Set(["stalled"]), "all")).toBe(false);
    expect(isFilterSelected(new Set(["stalled"]), "stalled")).toBe(true);
  });
});

describe("liveNowMs", () => {
  it("follows the tick, up to a minute past the last poll", () => {
    expect(liveNowMs(NOW + 30_000, NOW)).toBe(NOW + 30_000);
    expect(liveNowMs(NOW + 10 * MIN, NOW)).toBe(NOW + MIN);
  });
});

describe("formatElapsed", () => {
  it("shows m:ss under an hour and h:mm:ss from an hour", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(34 * MIN + 12_000)).toBe("34:12");
    expect(formatElapsed(108 * MIN + 30_000)).toBe("1:48:30");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("formatAgo", () => {
  it("reads in seconds, then minutes, then hours and minutes", () => {
    expect(formatAgo(2_000)).toBe("2s");
    expect(formatAgo(31 * MIN + 5_000)).toBe("31m");
    expect(formatAgo(63 * MIN)).toBe("1h 3m");
  });
});

describe("commandHead", () => {
  it("keeps the first line and cuts it to the limit", () => {
    expect(commandHead("make ci\necho done")).toBe("make ci");
    expect(commandHead("abcdef", 4)).toBe("abc…");
  });
});
