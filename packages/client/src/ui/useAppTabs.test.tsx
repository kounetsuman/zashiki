// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
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
