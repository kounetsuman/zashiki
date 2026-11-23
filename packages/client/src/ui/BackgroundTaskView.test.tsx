// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type BackgroundTask, DEFAULT_STALL_RULES } from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackgroundTaskView,
  type BackgroundTaskViewProps,
} from "./BackgroundTaskView.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function task(over: Partial<BackgroundTask>): BackgroundTask {
  return {
    cockpitTerminalId: "t1",
    org: "wonder",
    repo: "wonder-api",
    cwd: "/w/wonder-api",
    sid: "s1",
    taskId: "b",
    description: "Run CI",
    command: "make ci",
    startedAt: NOW - MIN,
    phase: "running",
    outputModifiedAt: NOW - 2_000,
    lastLineRepeats: 0,
    ...over,
  };
}

function renderView(
  tasks: BackgroundTask[],
  onOpenCockpitTerminal: (id: string) => void = () => {},
  idleTerminals?: BackgroundTaskViewProps["idleTerminals"],
) {
  render(
    <BackgroundTaskView
      tasks={tasks}
      fetchedAt={NOW}
      rules={DEFAULT_STALL_RULES}
      onOpenCockpitTerminal={onOpenCockpitTerminal}
      idleTerminals={idleTerminals}
    />,
  );
}

const filter = (name: string) => screen.getByRole("button", { name });

const rowOf = (taskId: string) =>
  document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement;

describe("BackgroundTaskView", () => {
  it("puts the idle terminals above the filters, and opens one from its title", () => {
    const onOpen = vi.fn();
    renderView([task({})], onOpen, {
      rows: [
        {
          terminal: {
            cockpitTerminalId: "idle1",
            name: "idle1",
            org: "wonder",
            repo: "wonder-api",
            state: "idle",
            title: null,
            active: false,
          },
          title: "放置した作業",
          lastActivityAt: NOW - 3 * 24 * 60 * MIN,
        },
      ],
      api: { tail: vi.fn(async () => []) },
      onCloseCockpitTerminal: vi.fn(),
    });
    const group = document.querySelector(".idle-terminal-group");
    const filters = document.querySelector(".background-task-filters");
    expect(group?.textContent).toContain("3 日");
    expect(
      group !== null &&
        filters !== null &&
        group.compareDocumentPosition(filters) &
          Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "放置した作業" }));
    expect(onOpen).toHaveBeenCalledWith("idle1");
  });

  it("moves the idle days on with its own clock", () => {
    renderView([], () => {}, {
      rows: [
        {
          terminal: {
            cockpitTerminalId: "idle1",
            name: "idle1",
            org: "wonder",
            repo: "wonder-api",
            state: "idle",
            title: null,
            active: false,
          },
          title: "放置した作業",
          lastActivityAt: NOW - 3 * 24 * 60 * MIN,
        },
      ],
      api: { tail: vi.fn(async () => []) },
      onCloseCockpitTerminal: vi.fn(),
    });
    const days = () =>
      document.querySelector(".idle-terminal-days")?.textContent;
    expect(days()).toBe("3 日");
    act(() => {
      vi.advanceTimersByTime(24 * 60 * MIN);
    });
    expect(days()).toBe("4 日");
  });

  it("shows a stalled task with its elapsed time, command, place, and the measured values that fired", () => {
    renderView([
      task({
        taskId: "stuck",
        title: "CI を直す",
        startedAt: NOW - 34 * MIN - 12_000,
        outputModifiedAt: NOW - 31 * MIN,
        lastLine: "完了を待機します",
        lastLineRepeats: 42,
      }),
    ]);
    const row = rowOf("stuck");
    expect(row.className).toContain("background-task-stalled");
    expect(row.textContent).toContain("止まっていそう");
    expect(row.textContent).toContain("Run CI");
    expect(row.textContent).toContain("34:12");
    expect(row.textContent).toContain("$ make ci");
    expect(row.textContent).toContain(
      "wonder / wonder-api · CI を直す · 出力 31m 前",
    );
    expect(row.textContent).toContain(
      "起動 34m (>20m) · 無出力 31m (>5m) · 末尾の同じ行が 42 回続く: 完了を待機します",
    );
  });

  it("labels ended and disconnected tasks without a reason line", () => {
    renderView([
      task({
        taskId: "ok",
        phase: "ended",
        exitCode: 0,
        endedAt: NOW - 2 * MIN,
      }),
      task({ taskId: "bad", phase: "ended", endStatus: "failed", exitCode: 3 }),
      task({ taskId: "pending", phase: "ended" }),
      task({ taskId: "cut", phase: "disconnected", startedAt: NOW - 90 * MIN }),
    ]);
    fireEvent.click(filter("すべて 4"));
    expect(rowOf("ok").textContent).toContain("終了 0");
    expect(rowOf("ok").textContent).toContain("2m 前に終了");
    expect(rowOf("ok").className).toContain("background-task-ok");
    expect(rowOf("bad").className).toContain("background-task-failed");
    expect(rowOf("pending").textContent).toContain("終了（完了通知なし）");
    expect(rowOf("cut").textContent).toContain("切断");
    expect(rowOf("cut").textContent).toContain(
      "セッション終了で切れた（完了通知なし）",
    );
    expect(document.querySelector(".background-task-reason")).toBeNull();
  });

  it("starts on stalled + running, toggles statuses one by one, and All shows every row", () => {
    renderView([
      task({ taskId: "run" }),
      task({ taskId: "stuck", startedAt: NOW - 30 * MIN }),
      task({ taskId: "done", phase: "ended", exitCode: 0 }),
    ]);
    expect(filter("止まっていそう 1").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(filter("実行中 1").getAttribute("aria-pressed")).toBe("true");
    expect(rowOf("stuck")).not.toBeNull();
    expect(rowOf("run")).not.toBeNull();
    expect(rowOf("done")).toBeNull();

    fireEvent.click(filter("実行中 1"));
    expect(rowOf("run")).toBeNull();
    expect(rowOf("stuck")).not.toBeNull();

    fireEvent.click(filter("終了 1"));
    expect(rowOf("done")).not.toBeNull();
    expect(rowOf("run")).toBeNull();

    fireEvent.click(filter("すべて 3"));
    expect(filter("すべて 3").getAttribute("aria-pressed")).toBe("true");
    expect(filter("終了 1").getAttribute("aria-pressed")).toBe("false");
    expect(rowOf("run")).not.toBeNull();
  });

  it("advances the elapsed time every second between polls, and re-judges the status", () => {
    renderView([task({ taskId: "x", startedAt: NOW - 20 * MIN + 1_000 })]);
    expect(rowOf("x").textContent).toContain("19:59");
    expect(rowOf("x").className).toContain("background-task-running");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(rowOf("x").textContent).toContain("20:00");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(rowOf("x").textContent).toContain("20:01");
    expect(rowOf("x").className).toContain("background-task-stalled");
  });

  it("holds the clock a minute past the last poll so a failing poll cannot flag tasks stalled", () => {
    renderView([task({ taskId: "x", outputModifiedAt: NOW - 4 * MIN })]);
    act(() => {
      vi.advanceTimersByTime(5 * MIN);
    });
    expect(rowOf("x").textContent).toContain("2:00");
    expect(rowOf("x").className).toContain("background-task-running");
  });

  it("opens the task's Cockpit Terminal from a click anywhere on its row, but not after selecting text", () => {
    const open = vi.fn();
    renderView([task({ taskId: "x", cockpitTerminalId: "t9" })], open);
    fireEvent.click(rowOf("x").querySelector("button") as HTMLElement);
    fireEvent.click(
      rowOf("x").querySelector(".background-task-command") as HTMLElement,
    );
    expect(open.mock.calls).toEqual([["t9"], ["t9"]]);

    const command = rowOf("x").querySelector(
      ".background-task-command",
    ) as HTMLElement;
    window.getSelection()?.selectAllChildren(command);
    fireEvent.click(command, { detail: 1 });
    expect(open).toHaveBeenCalledTimes(2);
    fireEvent.click(rowOf("x").querySelector("button") as HTMLElement, {
      detail: 0,
    });
    expect(open).toHaveBeenCalledTimes(3);
    window.getSelection()?.removeAllRanges();
  });

  it("still opens from a pointer click while text elsewhere on the page is selected", () => {
    const open = vi.fn();
    renderView([task({ taskId: "x", cockpitTerminalId: "t9" })], open);
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    window.getSelection()?.selectAllChildren(outside);
    fireEvent.click(
      rowOf("x").querySelector(".background-task-command") as HTMLElement,
      { detail: 1 },
    );
    expect(open).toHaveBeenCalledWith("t9");
    window.getSelection()?.removeAllRanges();
    outside.remove();
  });

  it("says no task matches when the selected statuses hide every row", () => {
    renderView([task({ taskId: "done", phase: "ended", exitCode: 0 })]);
    expect(screen.getByText("選んだ状態のタスクはありません。")).toBeTruthy();
  });

  it("falls back to the command when there is no description, and shows the empty state", () => {
    renderView([task({ taskId: "x", description: "", command: "sleep 3600" })]);
    expect(
      rowOf("x").querySelector(".background-task-description")?.textContent,
    ).toBe("sleep 3600");
    cleanup();
    renderView([]);
    expect(
      screen.getByText(
        "開いている Claude Session にバックグラウンドタスクはありません。",
      ),
    ).toBeTruthy();
  });
});
