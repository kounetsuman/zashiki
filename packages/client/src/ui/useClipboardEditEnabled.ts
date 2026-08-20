import { useCallback, useState } from "react";

import {
  loadClipboardEditEnabled,
  saveClipboardEditEnabled,
} from "../lib/clipboard-edit-modal.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StoragePart | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export interface ClipboardEditControl {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
}

/**
 * Owns whether the clipboard-edit modal appears, shared by the SETTINGS toggle and the modal's own
 * "don't show again" switch so both stay in sync. Initialized from and persisted to localStorage.
 */
export function useClipboardEditEnabled(
  storage: StoragePart | null = defaultStorage(),
): ClipboardEditControl {
  const [enabled, setEnabledState] = useState(() =>
    loadClipboardEditEnabled(storage),
  );
  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState((prev) => {
        if (next === prev) return prev;
        saveClipboardEditEnabled(storage, next);
        return next;
      });
    },
    [storage],
  );
  return { enabled, setEnabled };
}
