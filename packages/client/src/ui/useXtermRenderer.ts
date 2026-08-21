import { useCallback, useState } from "react";

import {
  loadXtermRenderer,
  saveXtermRenderer,
  type XtermRenderer,
} from "./xterm-renderer.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StoragePart | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export interface XtermRendererControl {
  renderer: XtermRenderer;
  setRenderer(next: XtermRenderer): void;
}

/**
 * Owns the xterm renderer choice for the whole app: initialized from the persisted value and
 * re-persisted on change (storage injectable for tests). Lifting it here lets the Settings view
 * switch renderers while TerminalView (rendered elsewhere) reflects the same value live.
 */
export function useXtermRenderer(
  storage: StoragePart | null = defaultStorage(),
): XtermRendererControl {
  const [renderer, setRendererState] = useState(() =>
    loadXtermRenderer(storage),
  );

  const setRenderer = useCallback(
    (next: XtermRenderer) => {
      setRendererState((prev) => {
        if (next === prev) return prev;
        saveXtermRenderer(storage, next);
        return next;
      });
    },
    [storage],
  );

  return { renderer, setRenderer };
}
