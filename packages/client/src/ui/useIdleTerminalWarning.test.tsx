// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type {
  CockpitTerminalInfo,
  CockpitTerminalLastActivityResponse,
} from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";
import {
  IDLE_THRESHOLD_MS,
  IDLE_WARNING_SHOWN_DAY_KEY,
  type IdleTerminals,
} from "../lib/idle-terminal-warning.js";
import {
  IDLE_CHECK_INTERVAL_MS,
  useIdleTerminalWarning,
} from "./useIdleTerminalWarning.js";

const { isTauri } = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
const { listen } = vi.hoisted(() => ({
  listen: vi.fn((_event: string, _handler: () => void) =>
    Promise.resolve(vi.fn()),
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

const NOW = new Date(2026, 9, 20, 9, 0);
const TODAY = "2026-10-20";
const STALE = NOW.getTime() - IDLE_THRESHOLD_MS;
const FRESH = NOW.getTime() - 60_000;

const terminal = (id: string): CockpitTerminalInfo => ({
  cockpitTerminalId: id,
  name: id,
  org: "org",
  repo: "repo",
  state: "idle",
  title: null,
  active: false,
});

function apiReturning(
  terminals: CockpitTerminalLastActivityResponse["terminals"],
): CockpitTerminalsApi {
  return {
    lastActivity: vi.fn(async () => ({ terminals })),
    tail: vi.fn(async () => []),
  };
}

function mount(
  api: CockpitTerminalsApi,
  storage: ReturnType<typeof memoryStorage>,
  terminals: CockpitTerminalInfo[],
  blocked = false,
) {
  const state: { idle: IdleTerminals | null; dismiss(): void } = {
    idle: null,
    dismiss: () => undefined,
  };
  function Probe(props: {
    terminals: CockpitTerminalInfo[];
    blocked: boolean;
  }) {
    const warning = useIdleTerminalWarning(
      api,
      storage,
      props.terminals,
      props.blocked,
      () => NOW,
    );
    state.idle = warning.idle;
    state.dismiss = warning.dismiss;
    return null;
  }
  const { rerender } = render(
    <Probe terminals={terminals} blocked={blocked} />,
  );
  return {
    state,
    rerender: (next: CockpitTerminalInfo[], nextBlocked = false) =>
      act(() => rerender(<Probe terminals={next} blocked={nextBlocked} />)),
    wake: async () => {
      const handler = listen.mock.calls.at(-1)?.[1];
      if (handler === undefined) throw new Error("not subscribed");
      await act(async () => handler());
    },
  };
}

const flush = () => act(async () => undefined);

beforeEach(() => {
  listen.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useIdleTerminalWarning", () => {
  it("shows the listed terminals idle past the threshold at launch and spends the day", async () => {
    const storage = memoryStorage();
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: STALE },
      { cockpitTerminalId: "b", lastActivityAt: FRESH },
      { cockpitTerminalId: "gone", lastActivityAt: STALE },
    ]);
    const { state } = mount(api, storage, [terminal("a"), terminal("b")]);
    await flush();
    expect([...(state.idle ?? [])]).toEqual([["a", STALE]]);
    expect(storage.map.get(IDLE_WARNING_SHOWN_DAY_KEY)).toBe(TODAY);
  });

  it("waits for the terminal list before the launch check", async () => {
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: STALE },
    ]);
    const { state, rerender } = mount(api, memoryStorage(), []);
    await flush();
    expect(api.lastActivity).not.toHaveBeenCalled();
    rerender([terminal("a")]);
    await flush();
    expect(state.idle?.has("a")).toBe(true);
  });

  it("does not show again on a day it was already shown", async () => {
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: STALE },
    ]);
    const { state, wake } = mount(
      api,
      memoryStorage({ [IDLE_WARNING_SHOWN_DAY_KEY]: TODAY }),
      [terminal("a")],
    );
    await flush();
    await wake();
    expect(api.lastActivity).not.toHaveBeenCalled();
    expect(state.idle).toBeNull();
  });

  it("keeps the day unspent when nothing is idle, so a later check can still show", async () => {
    const storage = memoryStorage();
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: FRESH },
    ]);
    const { state, wake } = mount(api, storage, [terminal("a")]);
    await flush();
    expect(state.idle).toBeNull();
    expect(storage.map.has(IDLE_WARNING_SHOWN_DAY_KEY)).toBe(false);
    vi.mocked(api.lastActivity).mockResolvedValue({
      terminals: [{ cockpitTerminalId: "a", lastActivityAt: STALE }],
    });
    await wake();
    expect(state.idle?.has("a")).toBe(true);
  });

  it("checks hourly while the app stays open", async () => {
    vi.useFakeTimers();
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: FRESH },
    ]);
    mount(api, memoryStorage(), [terminal("a")]);
    await flush();
    expect(api.lastActivity).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(IDLE_CHECK_INTERVAL_MS);
    });
    expect(api.lastActivity).toHaveBeenCalledTimes(2);
  });

  it("does not check while blocked and runs the launch check once unblocked", async () => {
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: STALE },
    ]);
    const { state, rerender } = mount(
      api,
      memoryStorage(),
      [terminal("a")],
      true,
    );
    await flush();
    expect(api.lastActivity).not.toHaveBeenCalled();
    rerender([terminal("a")], false);
    await flush();
    expect(state.idle?.has("a")).toBe(true);
  });

  it("dismiss hides the warning", async () => {
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: STALE },
    ]);
    const { state } = mount(api, memoryStorage(), [terminal("a")]);
    await flush();
    act(() => state.dismiss());
    expect(state.idle).toBeNull();
  });
});
