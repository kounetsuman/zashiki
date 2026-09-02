import type React from "react";
import { useEffect, useState } from "react";
import { type Tab, tabKey } from "../tabs/tab-model.js";
import { splitViewerKey } from "../viewer/viewer-model.js";
import { clampMenuPos } from "./views.js";

export interface TabContextMenuState {
  menu: {
    key: string;
    /** Owning cockpit terminal id for a session tab; null for a viewer tab. */
    cockpitTerminalId: string | null;
    /** File the tab is showing, for a viewer tab; null for a session tab. */
    viewer: { repoPath: string; relPath: string } | null;
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

/**
 * Right-click menu for a tab. itemCount feeds the position clamp so the menu never overflows
 * below the pointer; Escape closes it.
 */
export function useTabContextMenu(itemCount: number): TabContextMenuState {
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
    const { x, y } = clampMenuPos(e.clientX, e.clientY, itemCount);
    setMenu({
      key: tabKey(tab),
      cockpitTerminalId: tab.kind === "session" ? tab.id : null,
      viewer: tab.kind === "viewer" ? splitViewerKey(tab.id) : null,
      pinnable: tab.kind !== "memo",
      pinned,
      x,
      y,
    });
  };

  const closeMenu = (): void => setMenu(null);

  return { menu, openMenu, closeMenu };
}
