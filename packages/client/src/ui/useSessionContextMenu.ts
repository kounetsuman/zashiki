import type { CockpitTerminalInfo } from "@zashiki/shared";
import type React from "react";
import { useEffect, useState } from "react";
import type { ContextMenu } from "./session-list-model.js";
import { clampMenuPos } from "./views.js";

export interface SessionContextMenuState {
  menu: ContextMenu | null;
  openOrgMenu(org: string): (e: React.MouseEvent) => void;
  openRowMenu(s: CockpitTerminalInfo): (e: React.MouseEvent) => void;
  closeMenu(): void;
}

/**
 * Owns the right-click menu target and position (clamped into the viewport) and closes it on Escape.
 * The row menu's item count feeds the clamp so the menu never overflows below the pointer; it is asked
 * per row, because some items only render for certain terminals and a fixed maximum would lift the
 * menu away from the pointer on every other row.
 */
export function useSessionContextMenu(
  rowItemCount: (s: CockpitTerminalInfo) => number,
): SessionContextMenuState {
  const [menu, setMenu] = useState<ContextMenu | null>(null);

  const openOrgMenu =
    (org: string) =>
    (e: React.MouseEvent): void => {
      e.preventDefault();
      const { x, y } = clampMenuPos(e.clientX, e.clientY);
      setMenu({ kind: "org", org, x, y });
    };

  const openRowMenu =
    (s: CockpitTerminalInfo) =>
    (e: React.MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = clampMenuPos(e.clientX, e.clientY, rowItemCount(s));
      setMenu({
        kind: "row",
        cockpitTerminalId: s.cockpitTerminalId,
        name: s.name,
        x,
        y,
      });
    };

  const closeMenu = (): void => setMenu(null);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  return { menu, openOrgMenu, openRowMenu, closeMenu };
}
