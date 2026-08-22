// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { GitDiffResponse } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitApi } from "../api/git.js";
import { diffKey } from "../diff/diff-model.js";
import i18n from "../i18n/index.js";
import { useDiff } from "./useDiff.js";

const flush = (): Promise<void> => act(async () => undefined);

const okPayload: GitDiffResponse = {
  oldText: "a\n",
  newText: "b\n",
  binary: false,
  tooLarge: false,
  added: 1,
  removed: 1,
};

/** A GitApi whose `diff` is fully controllable; every other method throws (unused here). */
function fakeGitApi(diff: GitApi["diff"]): GitApi {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    status: () => Promise.reject(new Error("unused")),
    stage: unused,
    unstage: unused,
    stageAll: () => Promise.reject(new Error("unused")),
    unstageAll: () => Promise.reject(new Error("unused")),
    removeWorktree: () => Promise.reject(new Error("unused")),
    open: unused,
    commit: () => Promise.reject(new Error("unused")),
    diff,
  };
}

const KEY = diffKey("/r", "a.ts", "changed");

afterEach(() => vi.useRealTimers());

describe("useDiff", () => {
  it("loads a diff and exposes it once, then converges to ready", async () => {
    let calls = 0;
    const api = fakeGitApi(() => {
      calls += 1;
      return Promise.resolve(okPayload);
    });
    const { result } = renderHook(({ key }) => useDiff(api, key), {
      initialProps: { key: null as string | null },
    });

    act(() => {
      result.current.ensureDiff("/r", "a.ts", "changed");
    });
    await flush();

    expect(result.current.buffers[KEY]?.status).toBe("ready");
    expect(result.current.buffers[KEY]?.payload).toEqual(okPayload);
    // A second ensure for the same key does not refetch.
    act(() => {
      result.current.ensureDiff("/r", "a.ts", "changed");
    });
    expect(calls).toBe(1);
  });

  it("maps an abort into the timeout message", async () => {
    const api = fakeGitApi(() =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    );
    const { result } = renderHook(() => useDiff(api, null));
    act(() => {
      result.current.ensureDiff("/r", "a.ts", "changed");
    });
    await flush();
    expect(result.current.buffers[KEY]?.status).toBe("error");
    expect(result.current.buffers[KEY]?.error).toBe(
      i18n.t("diff.fetchTimeout"),
    );
  });

  it("re-fetches the active diff on the interval and stops after it is closed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const api = fakeGitApi(() => {
      calls += 1;
      return Promise.resolve(okPayload);
    });
    const { result, rerender } = renderHook(({ key }) => useDiff(api, key), {
      initialProps: { key: null as string | null },
    });

    act(() => {
      result.current.ensureDiff("/r", "a.ts", "changed");
    });
    await flush();
    expect(calls).toBe(1);

    // Make it the active diff, then let one poll interval elapse.
    rerender({ key: KEY });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(calls).toBe(2);

    // Close the tab (drop the buffer + deactivate); no further polls fire.
    act(() => {
      result.current.closeDiff(KEY);
    });
    rerender({ key: null });
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(calls).toBe(2);
  });

  it("ignores a stale in-flight response after a newer fetch settles", async () => {
    vi.useFakeTimers();
    const resolvers: ((p: GitDiffResponse) => void)[] = [];
    const api = fakeGitApi(
      () => new Promise<GitDiffResponse>((res) => resolvers.push(res)),
    );
    const { result } = renderHook(() => useDiff(api, KEY));

    act(() => {
      result.current.ensureDiff("/r", "a.ts", "changed");
    });
    // The active-tab poll fires a second fetch for the same key before the first settles.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(resolvers.length).toBe(2);

    // Settle the newer fetch first, then the stale one; the stale result must not overwrite.
    await act(async () => {
      resolvers[1]?.(okPayload);
    });
    await act(async () => {
      resolvers[0]?.({ ...okPayload, newText: "STALE\n" });
    });
    expect(result.current.buffers[KEY]?.payload?.newText).toBe("b\n");
  });
});
