// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SessionEvent } from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_STATS_POLL_MS, useSessionStats } from "./useSessionStats.js";

function prompt(text: string): SessionEvent {
  return { at: 1, kind: "prompt", text };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSessionStats", () => {
  it("fetches the terminal's events at once and again every poll", async () => {
    const stats = vi.fn(async (id: string) => [prompt(id)]);
    const api = { stats };
    const { result } = renderHook(() => useSessionStats(api, "t1"));
    expect(result.current).toBeNull();
    await act(async () => {});
    expect(result.current).toEqual([prompt("t1")]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_STATS_POLL_MS);
    });
    expect(stats).toHaveBeenCalledTimes(2);
  });

  it("does not fetch while no terminal is given", async () => {
    const stats = vi.fn(async () => []);
    const api = { stats };
    const { result } = renderHook(() => useSessionStats(api, null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_STATS_POLL_MS);
    });
    expect(stats).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("drops the previous terminal's events when another is given", async () => {
    let resolve: (value: SessionEvent[]) => void = () => undefined;
    const stats = vi
      .fn<(id: string) => Promise<SessionEvent[]>>()
      .mockResolvedValueOnce([prompt("t1")])
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    const api = { stats };
    const { result, rerender } = renderHook(
      ({ id }) => useSessionStats(api, id),
      { initialProps: { id: "t1" } },
    );
    await act(async () => {});
    expect(result.current).toEqual([prompt("t1")]);

    rerender({ id: "t2" });
    expect(result.current).toBeNull();
    await act(async () => resolve([prompt("t2")]));
    expect(result.current).toEqual([prompt("t2")]);
  });

  it("keeps the last events when a poll fails", async () => {
    const stats = vi
      .fn<(id: string) => Promise<SessionEvent[]>>()
      .mockResolvedValueOnce([prompt("kept")])
      .mockRejectedValueOnce(new Error("HTTP 503"));
    const api = { stats };
    const { result } = renderHook(() => useSessionStats(api, "t1"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_STATS_POLL_MS);
    });
    expect(stats).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual([prompt("kept")]);
  });
});
