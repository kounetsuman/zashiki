// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type BackgroundTask, DEFAULT_STALL_RULES } from "@zashiki/shared";
import { afterEach, describe, expect, it } from "vitest";

import { backgroundTaskRows } from "../session/background-task-rows.js";
import { BackgroundTaskView } from "./BackgroundTaskView.js";

afterEach(cleanup);

const MIN = 60_000;
const NOW = 1_800_000_000_000;

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

function renderView(tasks: BackgroundTask[]) {
  render(
    <BackgroundTaskView
      rows={backgroundTaskRows(tasks, NOW, DEFAULT_STALL_RULES)}
      nowMs={NOW}
      rules={DEFAULT_STALL_RULES}
    />,
  );
}

const rowOf = (taskId: string) =>
  document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement;

describe("BackgroundTaskView", () => {
  it("shows a stalled task with its elapsed time, command, place, and the rules that fired", () => {
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
      "起動から 20 分超 · 出力が 5 分以上更新なし · 末尾の同じ行が 42 回続く: 完了を待機します",
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

  it("filters by status with counts on each filter", () => {
    renderView([
      task({ taskId: "run" }),
      task({ taskId: "stuck", startedAt: NOW - 30 * MIN }),
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "止まっていそう 1" }));
    expect(rowOf("stuck")).not.toBeNull();
    expect(rowOf("run")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "すべて 2" }));
    expect(rowOf("run")).not.toBeNull();
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
