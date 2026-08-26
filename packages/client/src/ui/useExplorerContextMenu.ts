import type { FsEntryKind } from "@zashiki/shared";
import type React from "react";
import { useEffect, useState } from "react";
import { clampMenuPos } from "./views.js";

export interface ExplorerMenuTarget {
  repoPath: string;
  /** Repo-relative path of the entry the menu acts on. */
  relPath: string;
  kind: FsEntryKind;
  /** Display name (last path segment), shown in the delete confirmation. */
  name: string;
  x: number;
  y: number;
}

export interface ExplorerContextMenuState {
  menu: ExplorerMenuTarget | null;
  openMenu(
    entry: Pick<ExplorerMenuTarget, "repoPath" | "relPath" | "kind" | "name">,
  ): (e: React.MouseEvent) => void;
  closeMenu(): void;
}

/** The number of items in the explorer entry menu; feeds the position clamp. */
const EXPLORER_MENU_ITEM_COUNT = 5;

/**
 * Owns the explorer entry right-click menu target and its clamped position, and closes it on Escape.
 * A single hook instance serves every row (only one menu is open at a time).
 */
export function useExplorerContextMenu(): ExplorerContextMenuState {
  const [menu, setMenu] = useState<ExplorerMenuTarget | null>(null);

  const openMenu =
    (
      entry: Pick<ExplorerMenuTarget, "repoPath" | "relPath" | "kind" | "name">,
    ) =>
    (e: React.MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = clampMenuPos(
        e.clientX,
        e.clientY,
        EXPLORER_MENU_ITEM_COUNT,
      );
      setMenu({ ...entry, x, y });
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

  return { menu, openMenu, closeMenu };
}
