// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import type { ClientMessage, ServerMessage } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FLUSH_TIMEOUT_MS,
  type SelfUpdate,
  useSelfUpdate,
} from "./useSelfUpdate.js";

const IDLE: SelfUpdate = { updating: false, perform: () => {} };

afterEach(cleanup);

function makeControl(sendResult = true) {
  const listeners = new Set<(m: ServerMessage) => void>();
  const sent: ClientMessage[] = [];
  return {
    sent,
    emit(m: ServerMessage) {
      for (const fn of listeners) fn(m);
    },
    control: {
      send(msg: ClientMessage): boolean {
        sent.push(msg);
        return sendResult;
      },
      onMessage(fn: (m: ServerMessage) => void): () => void {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
}

function Harness({
  ctl,
  flashToast,
  onState,
  flushUnsaved = async () => {},
}: {
  ctl: ReturnType<typeof makeControl>["control"];
  flashToast: (m: string) => void;
  onState: (s: { updating: boolean; perform: () => void }) => void;
  flushUnsaved?: () => Promise<void>;
}) {
  const s = useSelfUpdate(ctl, flashToast, (k) => k, flushUnsaved);
  onState(s);
  return null;
}

describe("useSelfUpdate", () => {
  it("sends update.perform and enters the updating state", async () => {
    const h = makeControl();
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={() => undefined}
        onState={(s) => (latest = s)}
      />,
    );
    await act(async () => latest.perform());
    expect(h.sent).toEqual([{ t: "update.perform" }]);
    expect(latest.updating).toBe(true);
  });

  it("flushes unsaved edits before sending update.perform", async () => {
    const h = makeControl();
    const flushUnsaved = vi.fn(async () => {
      expect(h.sent).toEqual([]);
    });
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={() => undefined}
        onState={(s) => (latest = s)}
        flushUnsaved={flushUnsaved}
      />,
    );
    await act(async () => latest.perform());
    expect(flushUnsaved).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([{ t: "update.perform" }]);
    expect(latest.updating).toBe(true);
  });

  it("aborts the update and toasts when flushing unsaved edits fails", async () => {
    const h = makeControl();
    const flashToast = vi.fn();
    const flushUnsaved = vi.fn(async () => {
      throw new Error("save failed");
    });
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={flashToast}
        onState={(s) => (latest = s)}
        flushUnsaved={flushUnsaved}
      />,
    );
    await act(async () => latest.perform());
    expect(h.sent).toEqual([]);
    expect(latest.updating).toBe(false);
    expect(flashToast).toHaveBeenCalledWith("update.saveFailed");
  });

  it("aborts the update and toasts when the flush hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const h = makeControl();
      const flashToast = vi.fn();
      let latest: SelfUpdate = IDLE;
      render(
        <Harness
          ctl={h.control}
          flashToast={flashToast}
          onState={(s) => (latest = s)}
          flushUnsaved={() => new Promise(() => {})}
        />,
      );
      act(() => {
        latest.perform();
      });
      expect(latest.updating).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS);
      });
      expect(h.sent).toEqual([]);
      expect(latest.updating).toBe(false);
      expect(flashToast).toHaveBeenCalledWith("update.saveFailed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the spinner when a stale update.status lands during the flush", async () => {
    const h = makeControl();
    // A failed broadcast from an earlier attempt arrives while the flush is in flight.
    const flushUnsaved = vi.fn(async () => {
      h.emit({ t: "update.status", state: "failed", detail: null });
    });
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={() => undefined}
        onState={(s) => (latest = s)}
        flushUnsaved={flushUnsaved}
      />,
    );
    await act(async () => latest.perform());
    expect(h.sent).toEqual([{ t: "update.perform" }]);
    expect(latest.updating).toBe(true);
  });

  it("flushes unsaved edits when an update starts from any client", async () => {
    const h = makeControl();
    const flushUnsaved = vi.fn(async () => {});
    render(
      <Harness
        ctl={h.control}
        flashToast={() => undefined}
        onState={() => {}}
        flushUnsaved={flushUnsaved}
      />,
    );
    await act(async () => {
      h.emit({ t: "update.status", state: "running", detail: null });
    });
    expect(flushUnsaved).toHaveBeenCalledTimes(1);
  });

  it("keeps updating on running/relaunching, clears and toasts on opened/failed", () => {
    const h = makeControl();
    const flashToast = vi.fn();
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={flashToast}
        onState={(s) => (latest = s)}
      />,
    );

    act(() => h.emit({ t: "update.status", state: "running", detail: null }));
    expect(latest.updating).toBe(true);
    act(() =>
      h.emit({ t: "update.status", state: "relaunching", detail: null }),
    );
    expect(latest.updating).toBe(true);

    act(() => h.emit({ t: "update.status", state: "opened", detail: null }));
    expect(latest.updating).toBe(false);
    expect(flashToast).toHaveBeenCalledWith("update.opened");

    act(() => h.emit({ t: "update.status", state: "running", detail: null }));
    act(() => h.emit({ t: "update.status", state: "failed", detail: "boom" }));
    expect(latest.updating).toBe(false);
    expect(flashToast).toHaveBeenCalledWith("update.failed");
  });

  it("keeps the spinner for another client's running update when the local flush fails", async () => {
    const h = makeControl();
    const flashToast = vi.fn();
    const flushUnsaved = vi
      .fn<() => Promise<void>>()
      // First call: the drain triggered by the running broadcast. Second: our failing perform.
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("save failed"));
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={flashToast}
        onState={(s) => (latest = s)}
        flushUnsaved={flushUnsaved}
      />,
    );
    await act(async () => {
      h.emit({ t: "update.status", state: "running", detail: null });
    });
    await act(async () => latest.perform());
    expect(flashToast).toHaveBeenCalledWith("update.saveFailed");
    expect(latest.updating).toBe(true);
  });

  it("toasts and leaves updating off when send fails after a successful flush", async () => {
    const h = makeControl(false);
    const flashToast = vi.fn();
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={flashToast}
        onState={(s) => (latest = s)}
      />,
    );
    await act(async () => latest.perform());
    expect(latest.updating).toBe(false);
    expect(flashToast).toHaveBeenCalledWith("update.failed");
  });
});
