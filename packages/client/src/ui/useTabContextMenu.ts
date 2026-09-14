import type React from "react";
import { useEffect, useState } from "react";
import { type Tab, tabKey } from "../tabs/tab-model.js";
import { type RepoFile, repoFileOfViewerKey } from "../viewer/viewer-model.js";
import { clampMenuPos } from "./views.js";

export interface TabContextMenuState {
  menu: {
    key: string;
    /** Owning cockpit terminal id for a session tab; null for a viewer tab. */
    cockpitTerminalId: string | null;
    /**
     * Repo file the tab is showing, for a viewer tab; null for a session tab and for an
     * external file (Cmd+O / drag-drop), which has no repo path for file actions to address.
     */
    viewer: RepoFile | null;
    /** Whether the tab exposes a pin toggle (every tab except the implicitly-pinned Memo tab). */
    pinnable: boolean;
    /** Current pin state, deciding whether the toggle reads "Pin" or "Unpin". */
    pinned: boolean;
    x: number;
    y: number;
  } | null;
  openMenu(tab: Tab, e: React.MouseEvent, pinned: boolean): void;
  closeMenu(): void;
}

/** Menu item counts feeding the position clamp, split by what renders for each tab kind. */
export interface TabMenuItemCounts {
  /** Items offered on every tab (close, close all, pin/unpin). */
  base: number;
  /** Extra items on a session tab (duplicate, copy session id). */
  session: number;
  /** Extra items on a viewer tab showing a repo file (reveal, copy absolute path, rename). */
  viewer: number;
}

/**
 * Right-click menu for a tab. The per-kind item counts feed the position clamp so the menu
 * never overflows below the pointer; Escape closes it.
 */
export function useTabContextMenu(
  counts: TabMenuItemCounts,
): TabContextMenuState {
  const [menu, setMenu] = useState<TabContextMenuState["menu"]>(null);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const openMenu = (tab: Tab, e: React.MouseEvent, pinned: boolean): void => {
    e.preventDefault();
    const viewer = tab.kind === "viewer" ? repoFileOfViewerKey(tab.id) : null;
    const kindItems =
      tab.kind === "session"
        ? counts.session
        : viewer !== null
          ? counts.viewer
          : 0;
    const { x, y } = clampMenuPos(
      e.clientX,
      e.clientY,
      counts.base + kindItems,
    );
    setMenu({
      key: tabKey(tab),
      cockpitTerminalId: tab.kind === "session" ? tab.id : null,
      viewer,
      pinnable: tab.kind !== "memo",
      pinned,
      x,
      y,
    });
  };

  const closeMenu = (): void => setMenu(null);

  return { menu, openMenu, closeMenu };
}
