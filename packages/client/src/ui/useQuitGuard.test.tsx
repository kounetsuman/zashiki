// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useQuitGuard } from "./useQuitGuard.js";

const listeners = new Map<string, (event: unknown) => void>();
const unlistenSpy = vi.fn();
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => undefined);
const isTauriMock = vi.fn(() => true);

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => isTauriMock(),
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: unknown) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(() => {
      listeners.delete(event);
      unlistenSpy();
    });
  },
}));

function emit(event: string): void {
  listeners.get(event)?.({ event, id: 0, payload: undefined });
}

/** Lets the microtasks from `listen`'s promise and the async save handler settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function Harness({
  dirty,
  flush = async () => {},
}: {
  dirty: boolean;
  flush?: () => Promise<void>;
}) {
  useQuitGuard(() => dirty, flush);
  return null;
}

afterEach(cleanup);
beforeEach(() => {
  listeners.clear();
  unlistenSpy.mockClear();
  invokeMock.mockClear();
  invokeMock.mockImplementation(async () => undefined);
  isTauriMock.mockReturnValue(true);
});

describe("useQuitGuard", () => {
  it("reports the current dirty state when the shell asks", async () => {
    render(<Harness dirty={true} />);
    await flushMicrotasks();

    emit("zashiki:memo-check");
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledWith("report_memo_status", {
      dirty: true,
    });
  });

  it("reports the live dirty state after a re-render, not a stale render-time value", async () => {
    const { rerender } = render(<Harness dirty={false} />);
    await flushMicrotasks();

    rerender(<Harness dirty={true} />);
    await flushMicrotasks();

    emit("zashiki:memo-check");
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenLastCalledWith("report_memo_status", {
      dirty: true,
    });
  });

  it("flushes and then reports the save landed when the shell asks", async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push("flush");
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return undefined;
    });
    render(<Harness dirty={true} flush={flush} />);
    await flushMicrotasks();

    emit("zashiki:memo-save");
    await flushMicrotasks();

    expect(flush).toHaveBeenCalledOnce();
    expect(order).toEqual(["flush", "report_memo_saved"]);
    expect(invokeMock).toHaveBeenLastCalledWith("report_memo_saved", {
      ok: true,
    });
  });

  it("reports the save failed so the shell keeps the app open", async () => {
    const flush = vi.fn(async () => {
      throw new Error("save failed");
    });
    render(<Harness dirty={true} flush={flush} />);
    await flushMicrotasks();

    emit("zashiki:memo-save");
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenLastCalledWith("report_memo_saved", {
      ok: false,
    });
  });

  it("stops handling shell requests after unmount", async () => {
    const flush = vi.fn(async () => {});
    const { unmount } = render(<Harness dirty={true} flush={flush} />);
    await flushMicrotasks();

    unmount();
    await flushMicrotasks();
    expect(unlistenSpy).toHaveBeenCalledTimes(2);

    emit("zashiki:memo-save");
    emit("zashiki:memo-check");
    await flushMicrotasks();
    expect(flush).not.toHaveBeenCalled();
  });

  it("does nothing outside Tauri", async () => {
    isTauriMock.mockReturnValue(false);
    render(<Harness dirty={true} />);
    await flushMicrotasks();

    expect(listeners.size).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
