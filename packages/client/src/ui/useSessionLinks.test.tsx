// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SessionLink } from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_LINKS_POLL_MS, useSessionLinks } from "./useSessionLinks.js";

function link(url: string): SessionLink {
  return { url, tab: "conversation", kind: "other", source: "user" };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSessionLinks", () => {
  it("fetches the active terminal's links at once and again every poll", async () => {
    const links = vi.fn(async (id: string) => [link(`https://${id}.example/`)]);
    const api = { links };
    const { result } = renderHook(() => useSessionLinks(api, "t1"));
    await act(async () => {});
    expect(links).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([link("https://t1.example/")]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LINKS_POLL_MS);
    });
    expect(links).toHaveBeenCalledTimes(2);
  });

  it("drops the previous terminal's links when another becomes active", async () => {
    let resolve: (value: SessionLink[]) => void = () => undefined;
    const links = vi
      .fn<(id: string) => Promise<SessionLink[]>>()
      .mockResolvedValueOnce([link("https://t1.example/")])
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    const api = { links };
    const { result, rerender } = renderHook(
      ({ id }) => useSessionLinks(api, id),
      { initialProps: { id: "t1" } },
    );
    await act(async () => {});
    expect(result.current).toHaveLength(1);

    rerender({ id: "t2" });
    expect(result.current).toEqual([]);
    expect(links).toHaveBeenLastCalledWith("t2", expect.any(AbortSignal));
    await act(async () => resolve([link("https://t2.example/")]));
    expect(result.current).toEqual([link("https://t2.example/")]);
  });

  it("keeps the last links when a poll fails", async () => {
    const links = vi
      .fn<(id: string) => Promise<SessionLink[]>>()
      .mockResolvedValueOnce([link("https://t1.example/")])
      .mockRejectedValueOnce(new Error("HTTP 500"));
    const api = { links };
    const { result } = renderHook(() => useSessionLinks(api, "t1"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LINKS_POLL_MS);
    });
    expect(links).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual([link("https://t1.example/")]);
  });

  it("stops polling once unmounted and fetches nothing without a terminal", async () => {
    const links = vi.fn(async () => []);
    const api = { links };
    const { unmount } = renderHook(() => useSessionLinks(api, "t1"));
    await act(async () => {});
    unmount();
    await vi.advanceTimersByTimeAsync(SESSION_LINKS_POLL_MS * 3);
    expect(links).toHaveBeenCalledTimes(1);

    const idle = vi.fn(async () => []);
    const idleApi = { links: idle };
    renderHook(() => useSessionLinks(idleApi, null));
    await vi.advanceTimersByTimeAsync(SESSION_LINKS_POLL_MS * 3);
    expect(idle).not.toHaveBeenCalled();
  });
});
