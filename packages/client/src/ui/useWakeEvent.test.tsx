// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWakeEvent } from "./useWakeEvent.js";

const { isTauri } = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
const { listen, unlisten } = vi.hoisted(() => {
  const unlisten = vi.fn();
  return {
    unlisten,
    listen: vi.fn((_event: string, _handler: () => void) =>
      Promise.resolve(unlisten),
    ),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

function Probe({ onWake }: { onWake: () => void }) {
  useWakeEvent(onWake);
  return null;
}

const wake = (): void => {
  const handler = listen.mock.calls[0]?.[1];
  if (handler === undefined) throw new Error("not subscribed");
  handler();
};

beforeEach(() => {
  isTauri.mockReturnValue(true);
  listen.mockClear();
  unlisten.mockClear();
});
afterEach(cleanup);

describe("useWakeEvent", () => {
  it("calls the handler on the shell's wake event", () => {
    const onWake = vi.fn();
    render(<Probe onWake={onWake} />);
    expect(listen.mock.calls[0]?.[0]).toBe("zashiki:did-wake");
    wake();
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("calls the handler the component rendered last, not the one it mounted with", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe onWake={first} />);
    rerender(<Probe onWake={second} />);
    wake();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1); // subscribed once
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<Probe onWake={vi.fn()} />);
    unmount();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
  });

  it("does nothing outside the Tauri shell, where there is no wake signal", () => {
    isTauri.mockReturnValue(false);
    render(<Probe onWake={vi.fn()} />);
    expect(listen).not.toHaveBeenCalled();
  });
});
