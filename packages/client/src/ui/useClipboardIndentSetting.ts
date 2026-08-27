import { useCallback, useState } from "react";

import {
  type IndentSetting,
  loadIndentSetting,
  saveIndentSetting,
} from "../lib/clipboard-edit-indent.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StoragePart | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export interface ClipboardIndentControl {
  setting: IndentSetting;
  setSetting(next: IndentSetting): void;
}

/**
 * Owns the clipboard-edit indent unit (tab vs. spaces and their width), initialized from and
 * persisted to localStorage so the choice carries across opens.
 */
export function useClipboardIndentSetting(
  storage: StoragePart | null = defaultStorage(),
): ClipboardIndentControl {
  const [setting, setState] = useState(() => loadIndentSetting(storage));
  const setSetting = useCallback(
    (next: IndentSetting) => {
      setState((prev) => {
        if (prev.useTab === next.useTab && prev.spaceCount === next.spaceCount)
          return prev;
        saveIndentSetting(storage, next);
        return next;
      });
    },
    [storage],
  );
  return { setting, setSetting };
}
