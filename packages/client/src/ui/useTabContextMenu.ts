import type { CockpitTerminalInfo } from "@zashiki/shared";
import type React from "react";
import { useEffect, useState } from "react";
import { clampMenuPos } from "./panels.js";

export interface TabContextMenuState {
  menu: { cockpitTerminalId: string; x: number; y: number } | null;
  openMenu(session: CockpitTerminalInfo, e: React.MouseEvent): void;
  closeMenu(): void;
}

/**
 * Right-click menu for a session tab (copy resume / session id). The item count feeds the position
 * clamp so the menu never overflows below the pointer; Escape closes it.
 */
export function useTabContextMenu(itemCount: number): TabContextMenuState {
  const [menu, setMenu] = useState<{
    cockpitTerminalId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const openMenu = (
    session: CockpitTerminalInfo,
    e: React.MouseEvent,
  ): void => {
    e.preventDefault();
    const { x, y } = clampMenuPos(e.clientX, e.clientY, itemCount);
    setMenu({ cockpitTerminalId: session.cockpitTerminalId, x, y });
  };

  const closeMenu = (): void => setMenu(null);

  return { menu, openMenu, closeMenu };
}
