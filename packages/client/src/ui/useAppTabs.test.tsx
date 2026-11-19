// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { CockpitTerminalInfo } from "@zashiki/shared";
import { describe, expect, it, vi } from "vitest";

import type { AppStore } from "../state/app-store.js";
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
