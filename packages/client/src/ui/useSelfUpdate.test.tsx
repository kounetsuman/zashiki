// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import type { ClientMessage, ServerMessage } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type SelfUpdate, useSelfUpdate } from "./useSelfUpdate.js";

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
}: {
  ctl: ReturnType<typeof makeControl>["control"];
  flashToast: (m: string) => void;
  onState: (s: { updating: boolean; perform: () => void }) => void;
}) {
  const s = useSelfUpdate(ctl, flashToast, (k) => k);
  onState(s);
  return null;
}

describe("useSelfUpdate", () => {
  it("sends update.perform and enters the updating state", () => {
    const h = makeControl();
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={() => undefined}
        onState={(s) => (latest = s)}
      />,
    );
    act(() => latest.perform());
    expect(h.sent).toEqual([{ t: "update.perform" }]);
    expect(latest.updating).toBe(true);
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

  it("does not enter updating when send fails (not connected)", () => {
    const h = makeControl(false);
    let latest: SelfUpdate = IDLE;
    render(
      <Harness
        ctl={h.control}
        flashToast={() => undefined}
        onState={(s) => (latest = s)}
      />,
    );
    act(() => latest.perform());
    expect(latest.updating).toBe(false);
  });
});
