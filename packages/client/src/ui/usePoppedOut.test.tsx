// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PopOutApi } from "../lib/pop-out.js";
import { usePoppedOut } from "./usePoppedOut.js";

afterEach(cleanup);

function fakeApi(open: string[] = []) {
  let closed: ((id: string) => void) | null = null;
  const api: PopOutApi = {
    open: vi.fn(async () => {}),
    focus: vi.fn(async (id: string) => open.includes(id)),
    close: vi.fn(async (id: string) => open.includes(id)),
    list: vi.fn(async () => open),
    onClosed: (fn) => {
      closed = fn;
      return () => {
        closed = null;
      };
    },
  };
  return { api, closeWindow: (id: string) => closed?.(id) };
}

describe("usePoppedOut", () => {
  it("starts from the windows the shell already has open", async () => {
    const { api } = fakeApi(["a"]);
    const { result } = renderHook(() => usePoppedOut(api, () => {}));
    await act(async () => {});
    expect([...result.current.ids]).toEqual(["a"]);
  });

  it("adds a terminal once its window has opened", async () => {
    const { api } = fakeApi();
    const { result } = renderHook(() => usePoppedOut(api, () => {}));
    await act(async () => {
      result.current.popOut("a", "zashiki", { x: 10, y: 20 });
    });
    expect(api.open).toHaveBeenCalledWith("a", "zashiki", { x: 10, y: 20 });
    expect([...result.current.ids]).toEqual(["a"]);
  });

  it("drops a terminal and reports it returned when its window closes", async () => {
    const { api, closeWindow } = fakeApi(["a", "b"]);
    const onReturned = vi.fn();
    const { result } = renderHook(() => usePoppedOut(api, onReturned));
    await act(async () => {});
    act(() => closeWindow("a"));
    expect([...result.current.ids]).toEqual(["b"]);
    expect(onReturned).toHaveBeenCalledWith("a");
  });

  it("returns a terminal by closing its window", async () => {
    const { api } = fakeApi(["a"]);
    const { result } = renderHook(() => usePoppedOut(api, () => {}));
    await act(async () => {});
    act(() => result.current.returnToMain("a"));
    expect(api.close).toHaveBeenCalledWith("a");
    // The set follows the shell's closed report, not the request.
    expect([...result.current.ids]).toEqual(["a"]);
  });

  it("drops a terminal whose window turns out to be gone already", async () => {
    for (const action of ["show", "returnToMain"] as const) {
      const { api } = fakeApi(["a", "b"]);
      const onReturned = vi.fn();
      const { result } = renderHook(() => usePoppedOut(api, onReturned));
      await act(async () => {});
      vi.mocked(api.focus).mockResolvedValueOnce(false);
      vi.mocked(api.close).mockResolvedValueOnce(false);
      await act(async () => result.current[action]("a"));
      expect([...result.current.ids], action).toEqual(["b"]);
      expect(onReturned, action).toHaveBeenCalledWith("a");
    }
  });

  it("does nothing outside the desktop app", async () => {
    const { result } = renderHook(() => usePoppedOut(undefined, () => {}));
    await act(async () => {
      result.current.popOut("a", "zashiki", null);
    });
    expect(result.current.ids.size).toBe(0);
  });
});
