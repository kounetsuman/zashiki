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

let nextRequest = 1;
function emit(event: string, request = nextRequest++): void {
  listeners.get(event)?.({ event, id: 0, payload: { request } });
}

/** Lets the microtasks from `listen`'s promise and the async save handler settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function Harness({
  dirty,
  flush = async () => {},
  onSaving,
}: {
  dirty: boolean;
  flush?: () => Promise<void>;
  onSaving?: (saving: boolean) => void;
}) {
  const saving = useQuitGuard(() => dirty, flush);
  onSaving?.(saving);
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
      request: expect.any(Number),
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
      request: expect.any(Number),
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
      request: expect.any(Number),
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
      request: expect.any(Number),
      ok: false,
    });
  });

  it("reports a save as in flight only while the flush is pending", async () => {
    let finishFlush = (): void => {};
    const flush = () =>
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      });
    const savingStates: boolean[] = [];
    render(
      <Harness
        dirty={true}
        flush={flush}
        onSaving={(s) => savingStates.push(s)}
      />,
    );
    await flushMicrotasks();
    expect(savingStates.at(-1)).toBe(false);

    emit("zashiki:memo-save");
    await flushMicrotasks();
    expect(savingStates.at(-1)).toBe(true);

    finishFlush();
    await flushMicrotasks();
    expect(savingStates.at(-1)).toBe(false);
  });

  it("clears the in-flight save when the flush rejects, so the window isn't left blocked", async () => {
    let failFlush = (): void => {};
    const flush = () =>
      new Promise<void>((_resolve, reject) => {
        failFlush = () => reject(new Error("save failed"));
      });
    const savingStates: boolean[] = [];
    render(
      <Harness
        dirty={true}
        flush={flush}
        onSaving={(s) => savingStates.push(s)}
      />,
    );
    await flushMicrotasks();

    emit("zashiki:memo-save");
    await flushMicrotasks();
    expect(savingStates.at(-1)).toBe(true);

    failFlush();
    await flushMicrotasks();

    expect(savingStates.at(-1)).toBe(false);
    expect(invokeMock).toHaveBeenLastCalledWith("report_memo_saved", {
      request: expect.any(Number),
      ok: false,
    });
  });

  it("answers each request with its own number so the shell can match them up", async () => {
    render(<Harness dirty={false} />);
    await flushMicrotasks();

    emit("zashiki:memo-check", 42);
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenLastCalledWith("report_memo_status", {
      request: 42,
      dirty: false,
    });
  });

  it("joins the running save when the shell retries instead of queueing another write", async () => {
    // Each extra write goes on the same queue, pushing the answer further past the wait that
    // produced the retry in the first place.
    const pending: Array<() => void> = [];
    const flush = vi.fn(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const savingStates: boolean[] = [];
    render(
      <Harness
        dirty={true}
        flush={flush}
        onSaving={(s) => savingStates.push(s)}
      />,
    );
    await flushMicrotasks();

    emit("zashiki:memo-save", 1);
    emit("zashiki:memo-save", 2);
    await flushMicrotasks();
    expect(flush).toHaveBeenCalledOnce();
    expect(savingStates.at(-1)).toBe(true);

    pending[0]?.();
    await flushMicrotasks();

    // Both requests are answered, each with its own number, and the window unblocks once.
    expect(savingStates.at(-1)).toBe(false);
    expect(invokeMock.mock.calls).toEqual(
      expect.arrayContaining([
        ["report_memo_saved", { request: 1, ok: true }],
        ["report_memo_saved", { request: 2, ok: true }],
      ]),
    );
  });

  it("starts a fresh save once the previous one has settled", async () => {
    const pending: Array<() => void> = [];
    const flush = vi.fn(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    render(<Harness dirty={true} flush={flush} />);
    await flushMicrotasks();

    emit("zashiki:memo-save");
    await flushMicrotasks();
    pending[0]?.();
    await flushMicrotasks();

    emit("zashiki:memo-save");
    await flushMicrotasks();

    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("unblocks the window when the shell stops waiting, so a cancelled quit is usable", async () => {
    const flush = () => new Promise<void>(() => {});
    const savingStates: boolean[] = [];
    render(
      <Harness
        dirty={true}
        flush={flush}
        onSaving={(s) => savingStates.push(s)}
      />,
    );
    await flushMicrotasks();

    emit("zashiki:memo-save");
    await flushMicrotasks();
    expect(savingStates.at(-1)).toBe(true);

    emit("zashiki:memo-save-abandoned");
    await flushMicrotasks();

    expect(savingStates.at(-1)).toBe(false);
  });

  it("stops handling shell requests after unmount", async () => {
    const flush = vi.fn(async () => {});
    const { unmount } = render(<Harness dirty={true} flush={flush} />);
    await flushMicrotasks();

    unmount();
    await flushMicrotasks();
    expect(unlistenSpy).toHaveBeenCalledTimes(3);

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
