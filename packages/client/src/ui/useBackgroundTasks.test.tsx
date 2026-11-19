// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type { BackgroundTask } from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_TASKS_POLL_MS,
  type BackgroundTasksSnapshot,
  useBackgroundTasks,
} from "./useBackgroundTasks.js";

const task = (taskId: string): BackgroundTask => ({
  cockpitTerminalId: "t1",
  org: "o",
  repo: "r",
  cwd: "/w/r",
  sid: "s1",
  taskId,
  description: "",
  command: "c",
  phase: "running",
  lastLineRepeats: 0,
});

function Probe({
  api,
  onSnapshot,
}: {
  api: { backgroundTasks(signal?: AbortSignal): Promise<BackgroundTask[]> };
  onSnapshot(s: BackgroundTasksSnapshot): void;
}) {
  onSnapshot(useBackgroundTasks(api, () => 42));
  return null;
}

describe("useBackgroundTasks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("fetches on mount, polls again, and keeps the last tasks when a poll fails", async () => {
    const backgroundTasks = vi
      .fn()
      .mockResolvedValue([task("b2")])
      .mockResolvedValueOnce([task("b1")])
      .mockRejectedValueOnce(new Error("down"));
    let latest: BackgroundTasksSnapshot | undefined;
    render(
      <Probe api={{ backgroundTasks }} onSnapshot={(s) => (latest = s)} />,
    );
    await act(async () => {});
    expect(latest).toEqual({ tasks: [task("b1")], fetchedAt: 42 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_TASKS_POLL_MS);
    });
    expect(latest?.tasks).toEqual([task("b1")]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_TASKS_POLL_MS);
    });
    expect(latest?.tasks).toEqual([task("b2")]);
  });
});
