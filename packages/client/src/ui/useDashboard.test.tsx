// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import {
  type DashboardSettings,
  DEFAULT_DASHBOARD_SETTINGS,
} from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type DashboardApi, DashboardReadError } from "../api/dashboard.js";
import {
  DASHBOARD_LAST_SHOWN_KEY,
  type DashboardFrame,
} from "../lib/dashboard.js";
import { useDashboard } from "./useDashboard.js";

const { isTauri, invoke } = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn((_command: string, _args?: unknown) => Promise.resolve()),
}));
const { listen } = vi.hoisted(() => ({
  listen: vi.fn((_event: string, _handler: () => void) =>
    Promise.resolve(vi.fn()),
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri, invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

const NOW = new Date(2026, 8, 14, 9, 0);
const TODAY = "2026-09-14";
const shownOn = (url: string, day: string): string =>
  JSON.stringify({ url, day });

interface Harness {
  frame: DashboardFrame | null;
  dismiss(): void;
}

/** Renders the hook and lets the shell's registration of the dashboard address settle. */
async function mount(
  settings: DashboardSettings | null,
  storage: ReturnType<typeof memoryStorage> | null,
  api?: DashboardApi,
  blocked = false,
): Promise<{ state: Harness; wake(): void; unblock(): void }> {
  const state: Harness = { frame: null, dismiss: () => undefined };
  function Probe({ blocked }: { blocked: boolean }) {
    const { frame, dismiss } = useDashboard(
      settings,
      api,
      storage,
      blocked,
      () => NOW,
    );
    state.frame = frame;
    state.dismiss = dismiss;
    return null;
  }
  const { rerender } = render(<Probe blocked={blocked} />);
  await act(async () => {});
  return {
    state,
    wake: () => {
      const handler = listen.mock.calls.at(-1)?.[1];
      if (handler === undefined) throw new Error("not subscribed");
      act(() => handler());
    },
    unblock: () => {
      act(() => rerender(<Probe blocked={false} />));
    },
  };
}

const configured = (
  patch: Partial<DashboardSettings> = {},
): DashboardSettings => ({
  ...DEFAULT_DASHBOARD_SETTINGS,
  url: "https://dash.example/board",
  ...patch,
});

beforeEach(() => {
  isTauri.mockReturnValue(true);
  listen.mockClear();
  invoke.mockClear();
});
afterEach(cleanup);

describe("useDashboard", () => {
  it("shows nothing before the settings arrive", async () => {
    const { state } = await mount(null, memoryStorage());
    expect(state.frame).toBeNull();
  });

  it("shows nothing when no page is configured", async () => {
    const { state } = await mount(configured({ url: "" }), memoryStorage());
    expect(state.frame).toBeNull();
  });

  it("frames the configured page at launch and records the day", async () => {
    const storage = memoryStorage();
    const { state } = await mount(configured(), storage);
    expect(state.frame).toEqual({
      kind: "remote",
      url: "https://dash.example/board",
    });
    expect(storage.getItem(DASHBOARD_LAST_SHOWN_KEY)).toBe(
      shownOn("https://dash.example/board", TODAY),
    );
  });

  it("frames a web page only once the shell has registered its address", async () => {
    let registered: () => void = () => undefined;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          registered = resolve;
        }),
    );
    const storage = memoryStorage();
    const state: { frame: DashboardFrame | null } = { frame: null };
    function Probe() {
      state.frame = useDashboard(
        configured(),
        undefined,
        storage,
        false,
        () => NOW,
      ).frame;
      return null;
    }
    render(<Probe />);
    expect(invoke).toHaveBeenCalledWith("set_dashboard_origin", {
      url: "https://dash.example/board",
    });
    expect(state.frame).toBeNull();
    expect(storage.getItem(DASHBOARD_LAST_SHOWN_KEY)).not.toBeNull();

    await act(async () => registered());
    expect(state.frame).toEqual({
      kind: "remote",
      url: "https://dash.example/board",
    });
  });

  it("still frames the page when the shell could not be told", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invoke.mockImplementationOnce(() => Promise.reject(new Error("ipc down")));
    const { state } = await mount(configured(), memoryStorage());
    expect(state.frame).not.toBeNull();
    warn.mockRestore();
  });

  it("withdraws the framed address when the setting stops naming a web page", async () => {
    await mount(configured({ url: "" }), memoryStorage());
    expect(invoke).toHaveBeenCalledWith("set_dashboard_origin", { url: "" });
  });

  it("says so when the shell could not be told", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invoke.mockImplementationOnce(() => Promise.reject(new Error("ipc down")));
    await mount(configured(), memoryStorage());
    expect(warn).toHaveBeenCalledWith(
      "could not tell the shell the dashboard address",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("has nothing to tell outside the desktop app", async () => {
    isTauri.mockReturnValue(false);
    const { state } = await mount(configured(), memoryStorage());
    expect(state.frame).not.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stays out of the way until the wake it was configured for", async () => {
    const { state, wake } = await mount(
      configured({ showOn: "wake" }),
      memoryStorage(),
    );
    expect(state.frame).toBeNull();
    wake();
    expect(state.frame).toEqual({
      kind: "remote",
      url: "https://dash.example/board",
    });
  });

  it("skips a wake that is already the day's second showing at once_per_day", async () => {
    const { state, wake } = await mount(
      configured({ showOn: "wake", frequency: "once_per_day" }),
      memoryStorage({
        [DASHBOARD_LAST_SHOWN_KEY]: shownOn(
          "https://dash.example/board",
          TODAY,
        ),
      }),
    );
    wake();
    expect(state.frame).toBeNull();
  });

  it("shows again on a later wake at every_time", async () => {
    const { state, wake } = await mount(
      configured({ showOn: "both", frequency: "every_time" }),
      memoryStorage(),
    );
    act(() => state.dismiss());
    expect(state.frame).toBeNull();
    wake();
    expect(state.frame).not.toBeNull();
  });

  it("reads a local file's HTML through the server", async () => {
    const api: DashboardApi = {
      read: vi.fn(async () => "<h1>goals</h1>"),
    };
    const { state } = await mount(
      configured({ url: "~/board.html" }),
      memoryStorage(),
      api,
    );
    await act(async () => undefined);
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(state.frame).toEqual({ kind: "local", html: "<h1>goals</h1>" });
  });

  it("reports why a local file could not be read", async () => {
    const api: DashboardApi = {
      read: vi.fn(() => Promise.reject(new Error("file not found"))),
    };
    const { state } = await mount(
      configured({ url: "/Users/me/gone.html" }),
      memoryStorage(),
      api,
    );
    await act(async () => undefined);
    expect(state.frame).toEqual({ kind: "error", detail: "file not found" });
  });

  it("stays closed when it is dismissed while the local file is still being read", async () => {
    let land: (html: string) => void = () => undefined;
    const api: DashboardApi = {
      read: vi.fn(
        (signal?: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            land = resolve;
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    };
    const storage = memoryStorage();
    const { state } = await mount(
      configured({ url: "~/board.html", frequency: "once_per_day" }),
      storage,
      api,
    );
    act(() => state.dismiss());
    act(() => land("<h1>goals</h1>"));
    await act(async () => undefined);
    expect(state.frame).toBeNull();
    expect(storage.getItem(DASHBOARD_LAST_SHOWN_KEY)).toBeNull();
  });

  it("leaves the day free when it has no way to read the local file", async () => {
    const storage = memoryStorage();
    const { state } = await mount(
      configured({ url: "~/board.html", frequency: "once_per_day" }),
      storage,
    );
    expect(state.frame).toBeNull();
    expect(storage.getItem(DASHBOARD_LAST_SHOWN_KEY)).toBeNull();
  });

  it("spends the day when the server refuses the address it is configured with", async () => {
    const api: DashboardApi = {
      read: vi.fn(() =>
        Promise.reject(
          new DashboardReadError(
            400,
            "the dashboard file must be an .html file",
          ),
        ),
      ),
    };
    const storage = memoryStorage();
    const { state } = await mount(
      configured({ url: "~/board.txt", frequency: "once_per_day" }),
      storage,
      api,
    );
    await act(async () => undefined);
    expect(state.frame).toEqual({
      kind: "error",
      detail: "the dashboard file must be an .html file",
    });
    // Otherwise every wake for the rest of the day would pop the same notice.
    expect(storage.getItem(DASHBOARD_LAST_SHOWN_KEY)).toBe(
      shownOn("~/board.txt", TODAY),
    );
  });

  it("says a repeated refusal once a day even at every_time, instead of on every wake", async () => {
    const api: DashboardApi = {
      read: vi.fn(() =>
        Promise.reject(new DashboardReadError(404, "file not found")),
      ),
    };
    const { state, wake } = await mount(
      configured({
        url: "~/board.html",
        showOn: "both",
        frequency: "every_time",
      }),
      memoryStorage({
        [DASHBOARD_LAST_SHOWN_KEY]: shownOn("~/board.html", TODAY),
      }),
      api,
    );
    wake();
    await act(async () => undefined);
    expect(state.frame).toBeNull();
  });

  it("leaves the day free when all it could show was the read failure", async () => {
    const api: DashboardApi = {
      read: vi.fn(() => Promise.reject(new Error("file not found"))),
    };
    const storage = memoryStorage();
    const { state } = await mount(
      configured({ url: "~/board.html", frequency: "once_per_day" }),
      storage,
      api,
    );
    await act(async () => undefined);
    expect(state.frame).toEqual({ kind: "error", detail: "file not found" });
    expect(storage.getItem(DASHBOARD_LAST_SHOWN_KEY)).toBeNull();
  });

  it("shows a newly configured address today, even after another one was shown", async () => {
    const { state, wake } = await mount(
      configured({
        showOn: "wake",
        frequency: "once_per_day",
        url: "https://dash.example/other",
      }),
      memoryStorage({
        [DASHBOARD_LAST_SHOWN_KEY]: shownOn(
          "https://dash.example/board",
          TODAY,
        ),
      }),
    );
    wake();
    expect(state.frame).toEqual({
      kind: "remote",
      url: "https://dash.example/other",
    });
  });

  it("waits rather than spending the day while something more urgent is up", async () => {
    const storage = memoryStorage();
    const { state, unblock } = await mount(
      configured({ frequency: "once_per_day" }),
      storage,
      undefined,
      true,
    );
    expect(state.frame).toBeNull();
    expect(storage.getItem(DASHBOARD_LAST_SHOWN_KEY)).toBeNull();

    unblock();
    expect(state.frame).toEqual({
      kind: "remote",
      url: "https://dash.example/board",
    });
  });

  it("dismisses the page it is showing", async () => {
    const { state } = await mount(configured(), memoryStorage());
    act(() => state.dismiss());
    expect(state.frame).toBeNull();
  });
});
