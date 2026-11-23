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
  type IdleCockpitTerminals,
} from "../lib/idle-cockpit-terminals.js";
import {
  IDLE_CHECK_INTERVAL_MS,
  useIdleCockpitTerminals,
} from "./useIdleCockpitTerminals.js";

const { isTauri } = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
const { listen } = vi.hoisted(() => ({
  listen: vi.fn((_event: string, _handler: () => void) =>
    Promise.resolve(vi.fn()),
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const NOW = new Date(2026, 9, 20, 9, 0);
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
    links: vi.fn(async () => []),
    stats: vi.fn(async () => []),
    faviconUrl: (origin) => origin,
    backgroundTasks: vi.fn(async () => []),
  };
}

function mount(api: CockpitTerminalsApi, terminals: CockpitTerminalInfo[]) {
  const state: { idle: IdleCockpitTerminals } = { idle: new Map() };
  function Probe(props: { terminals: CockpitTerminalInfo[] }) {
    state.idle = useIdleCockpitTerminals(api, props.terminals, () => NOW);
    return null;
  }
  const { rerender } = render(<Probe terminals={terminals} />);
  return {
    state,
    rerender: (next: CockpitTerminalInfo[]) =>
      act(() => rerender(<Probe terminals={next} />)),
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

describe("useIdleCockpitTerminals", () => {
  it("finds the listed terminals idle past the threshold at launch", async () => {
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: STALE },
      { cockpitTerminalId: "b", lastActivityAt: FRESH },
      { cockpitTerminalId: "gone", lastActivityAt: STALE },
    ]);
    const { state } = mount(api, [terminal("a"), terminal("b")]);
    await flush();
    expect([...state.idle]).toEqual([["a", STALE]]);
  });

  it("waits for the terminal list before the launch check", async () => {
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: STALE },
    ]);
    const { state, rerender } = mount(api, []);
    await flush();
    expect(api.lastActivity).not.toHaveBeenCalled();
    rerender([terminal("a")]);
    await flush();
    expect(state.idle.has("a")).toBe(true);
  });

  it("checks again on every wake and takes each answer, including an empty one", async () => {
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: FRESH },
    ]);
    const { state, wake } = mount(api, [terminal("a")]);
    await flush();
    expect(state.idle.size).toBe(0);
    vi.mocked(api.lastActivity).mockResolvedValue({
      terminals: [{ cockpitTerminalId: "a", lastActivityAt: STALE }],
    });
    await wake();
    expect(state.idle.has("a")).toBe(true);
    await wake();
    expect(state.idle.has("a")).toBe(true);
    vi.mocked(api.lastActivity).mockResolvedValue({
      terminals: [{ cockpitTerminalId: "a", lastActivityAt: FRESH }],
    });
    await wake();
    expect(state.idle.size).toBe(0);
    expect(api.lastActivity).toHaveBeenCalledTimes(4);
  });

  it("checks hourly while the app stays open", async () => {
    vi.useFakeTimers();
    const api = apiReturning([
      { cockpitTerminalId: "a", lastActivityAt: FRESH },
    ]);
    mount(api, [terminal("a")]);
    await flush();
    expect(api.lastActivity).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(IDLE_CHECK_INTERVAL_MS);
    });
    expect(api.lastActivity).toHaveBeenCalledTimes(2);
  });
});
