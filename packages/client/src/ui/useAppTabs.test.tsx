// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { CockpitTerminalInfo } from "@zashiki/shared";
import { describe, expect, it, vi } from "vitest";

import type { AppStore } from "../state/app-store.js";
import { PINNED_SESSIONS_KEY } from "../tabs/pinned-sessions.js";
import { MEMO_TAB_KEY } from "../tabs/tab-model.js";
import { useAppTabs } from "./useAppTabs.js";

function fakeStore(): AppStore {
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => {
      throw new Error("not used");
    },
    selectCockpitTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    deselect: vi.fn(),
    activateSessionToast: vi.fn(),
    dismissSessionToast: vi.fn(),
    markNewRequested: vi.fn(),
    clearError: vi.fn(),
    setMemoText: vi.fn(),
    markMemoSaved: vi.fn(),
    beginAccountAction: vi.fn(),
  };
}

describe("useAppTabs memo tab", () => {
  it("adds the pinned Memo tab when memoEnabled turns on and removes it when off", () => {
    const store = fakeStore();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useAppTabs(store, [], null, enabled),
      { initialProps: { enabled: false } },
    );
    expect(result.current.tabsState.tabs).toHaveLength(0);
    expect(result.current.activeMemoKey).toBeNull();

    act(() => rerender({ enabled: true }));
    expect(result.current.tabsState.tabs.map((t) => t.kind)).toEqual(["memo"]);
    expect(result.current.activeMemoKey).toBe(MEMO_TAB_KEY);

    act(() => rerender({ enabled: false }));
    expect(result.current.tabsState.tabs).toHaveLength(0);
    expect(result.current.activeMemoKey).toBeNull();
  });
});

describe("useAppTabs startup", () => {
  const terminal = (id: string, active: boolean): CockpitTerminalInfo =>
    ({ cockpitTerminalId: id, active }) as CockpitTerminalInfo;

  it("keeps a file opened before the terminals arrived in front, with the terminal tab behind it", () => {
    const store = fakeStore();
    const { result, rerender } = renderHook(
      ({ terminals }: { terminals: CockpitTerminalInfo[] }) =>
        useAppTabs(store, terminals, null, false),
      { initialProps: { terminals: [] as CockpitTerminalInfo[] } },
    );
    act(() => result.current.openViewerTab("note.md"));
    // The server's first sync can still be empty before it has polled anything.
    act(() => rerender({ terminals: [] }));
    act(() =>
      rerender({ terminals: [terminal("@1", false), terminal("@2", true)] }),
    );
    expect(result.current.tabsState.tabs).toEqual([
      { kind: "session", id: "@2" },
      { kind: "viewer", id: "note.md" },
    ]);
    expect(result.current.activeViewerKey).toBe("note.md");
    expect(store.selectCockpitTerminal).not.toHaveBeenCalled();
  });

  it("selects the active terminal when nothing was open yet", () => {
    const store = fakeStore();
    renderHook(() =>
      useAppTabs(
        store,
        [terminal("@1", false), terminal("@2", true)],
        null,
        false,
      ),
    );
    expect(store.selectCockpitTerminal).toHaveBeenCalledWith("@2");
  });
});

describe("useAppTabs pinned terminals", () => {
  const terminal = (id: string, active = false): CockpitTerminalInfo =>
    ({ cockpitTerminalId: id, active }) as CockpitTerminalInfo;

  function memoryStorage(pinned?: string[]) {
    const data = new Map<string, string>();
    if (pinned !== undefined)
      data.set(PINNED_SESSIONS_KEY, JSON.stringify(pinned));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      pinned: () => JSON.parse(data.get(PINNED_SESSIONS_KEY) ?? "[]"),
    };
  }

  function mount(
    storage: ReturnType<typeof memoryStorage>,
    store: AppStore = fakeStore(),
  ) {
    return renderHook(
      ({
        terminals,
        selected,
      }: {
        terminals: CockpitTerminalInfo[];
        selected: string | null;
      }) => useAppTabs(store, terminals, selected, false, storage),
      {
        initialProps: {
          terminals: [] as CockpitTerminalInfo[],
          selected: null as string | null,
        },
      },
    );
  }

  it("remembers a pinned terminal and forgets it on unpin", () => {
    const storage = memoryStorage();
    const { result, rerender } = mount(storage);
    act(() => rerender({ terminals: [terminal("a")], selected: "a" }));
    act(() => result.current.pinTabByKey("session:a"));
    expect(storage.pinned()).toEqual(["a"]);
    act(() => result.current.unpinTabByKey("session:a"));
    expect(storage.pinned()).toEqual([]);
  });

  it("does not remember a pinned viewer tab", () => {
    const storage = memoryStorage();
    const { result } = mount(storage);
    act(() => result.current.openViewerTab("note.md"));
    act(() => result.current.pinTabByKey("viewer:note.md"));
    expect(storage.pinned()).toEqual([]);
  });

  it("reopens the remembered terminals pinned at startup, and the bootstrap still selects the active one", () => {
    const storage = memoryStorage(["b", "gone"]);
    const store = fakeStore();
    const { result, rerender } = mount(storage, store);
    act(() =>
      rerender({
        terminals: [terminal("a", true), terminal("b")],
        selected: null,
      }),
    );
    expect(result.current.tabsState.tabs).toEqual([
      { kind: "session", id: "b" },
    ]);
    expect(result.current.tabsState.pinned.has("session:b")).toBe(true);
    expect(store.selectCockpitTerminal).toHaveBeenCalledWith("a");
    expect(storage.pinned()).toEqual(["b"]);
  });

  it("keeps the pin of a terminal that drops out of the list and comes back", () => {
    const storage = memoryStorage();
    const { result, rerender } = mount(storage);
    const both = [terminal("a", true), terminal("b")];
    act(() => rerender({ terminals: both, selected: "a" }));
    act(() => rerender({ terminals: both, selected: "b" }));
    act(() => result.current.pinTabByKey("session:b"));

    act(() => rerender({ terminals: [terminal("a", true)], selected: "b" }));
    expect(result.current.tabsState.tabs).toEqual([
      { kind: "session", id: "a" },
    ]);

    act(() => rerender({ terminals: both, selected: "b" }));
    expect(result.current.tabsState.tabs[0]).toEqual({
      kind: "session",
      id: "b",
    });
    expect(result.current.tabsState.pinned.has("session:b")).toBe(true);
    expect(storage.pinned()).toEqual(["b"]);
  });

  it("returns a dropped terminal to its place among several pinned ones", () => {
    const storage = memoryStorage(["a", "b", "c"]);
    const { result, rerender } = mount(storage);
    const all = [terminal("a", true), terminal("b"), terminal("c")];
    act(() => rerender({ terminals: all, selected: "a" }));
    act(() =>
      rerender({
        terminals: [terminal("a", true), terminal("c")],
        selected: "a",
      }),
    );
    expect(storage.pinned()).toEqual(["a", "b", "c"]);
    act(() => rerender({ terminals: all, selected: "a" }));
    expect(result.current.tabsState.tabs.map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("persists the order of dragged pinned terminal tabs", () => {
    const storage = memoryStorage();
    const { result, rerender } = mount(storage);
    const both = [terminal("a", true), terminal("b")];
    act(() => rerender({ terminals: both, selected: "a" }));
    act(() => rerender({ terminals: both, selected: "b" }));
    act(() => result.current.pinTabByKey("session:a"));
    act(() => result.current.pinTabByKey("session:b"));
    act(() => result.current.reorderTabByKey("session:b", "session:a"));
    expect(storage.pinned()).toEqual(["b", "a"]);
  });
});
