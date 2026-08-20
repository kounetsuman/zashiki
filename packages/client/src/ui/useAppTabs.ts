import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppStore } from "../state/app-store.js";
import {
  activateTab,
  activeSessionId,
  activeTab,
  closeTab as closeTabModel,
  EMPTY_TABS,
  moveTab,
  openTab,
  pruneSessions,
  type TabsState,
  tabKey,
} from "../tabs/tab-model.js";

export interface AppTabs {
  tabsState: TabsState;
  /** cockpitTerminalId of the active session tab (null for a viewer/empty tab). */
  activeSess: string | null;
  /** Buffer key of the active viewer tab (null when the active tab is not a viewer). */
  activeViewerKey: string | null;
  activateTabByKey(key: string): void;
  /** Removes the tab only; the session (or viewer buffer) is closed by the caller. */
  closeTab(key: string): void;
  reorderTabByKey(fromKey: string, toKey: string): void;
  openViewerTab(key: string): void;
}

/**
 * Owns the main-area tab row, the single source of truth for what is open. The store's
 * selectedCockpitTerminalId (open request) flows one-way into the tabs, and the terminal attach flows
 * one-way back from the active session tab, so the round-trip does not loop.
 */
export function useAppTabs(
  store: AppStore,
  cockpitTerminals: readonly CockpitTerminalInfo[],
  selectedCockpitTerminalId: string | null,
): AppTabs {
  const [tabsState, setTabsState] = useState(EMPTY_TABS);
  const activeSess = activeSessionId(tabsState);
  const active = activeTab(tabsState);
  const activeViewerKey = active?.kind === "viewer" ? active.id : null;

  useEffect(() => {
    if (selectedCockpitTerminalId === null) return;
    setTabsState((prev) =>
      openTab(prev, { kind: "session", id: selectedCockpitTerminalId }),
    );
  }, [selectedCockpitTerminalId]);

  const selectedRef = useRef(selectedCockpitTerminalId);
  selectedRef.current = selectedCockpitTerminalId;
  useEffect(() => {
    if (activeSess !== null) {
      if (selectedRef.current !== activeSess)
        store.selectCockpitTerminal(activeSess);
    } else if (selectedRef.current !== null) {
      store.deselect();
    }
  }, [activeSess, store]);

  useEffect(() => {
    setTabsState((prev) =>
      pruneSessions(
        prev,
        cockpitTerminals.map((s) => s.cockpitTerminalId),
      ),
    );
  }, [cockpitTerminals]);

  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (tabsState.tabs.length > 0) {
      bootstrappedRef.current = true;
      return;
    }
    const w = cockpitTerminals.find((s) => s.active) ?? cockpitTerminals[0];
    if (w !== undefined) {
      bootstrappedRef.current = true;
      store.selectCockpitTerminal(w.cockpitTerminalId);
    }
  }, [cockpitTerminals, tabsState.tabs.length, store]);

  const activateTabByKey = useCallback(
    (key: string): void => {
      const tab = tabsState.tabs.find((t) => tabKey(t) === key);
      if (tab === undefined) return;
      if (tab.kind === "session") store.selectCockpitTerminal(tab.id);
      else setTabsState((prev) => activateTab(prev, key));
    },
    [tabsState.tabs, store],
  );

  const closeTab = useCallback((key: string): void => {
    setTabsState((prev) => closeTabModel(prev, key));
  }, []);

  const reorderTabByKey = useCallback(
    (fromKey: string, toKey: string): void => {
      setTabsState((prev) => moveTab(prev, fromKey, toKey));
    },
    [],
  );

  const openViewerTab = useCallback((key: string): void => {
    setTabsState((prev) => openTab(prev, { kind: "viewer", id: key }));
  }, []);

  return {
    tabsState,
    activeSess,
    activeViewerKey,
    activateTabByKey,
    closeTab,
    reorderTabByKey,
    openViewerTab,
  };
}
