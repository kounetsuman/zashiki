import { useCallback, useState } from "react";

import {
  canDecreaseTerminalFontSize,
  canIncreaseTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  loadTerminalFontSize,
  saveTerminalFontSize,
  stepTerminalFontSize,
} from "./terminal-font-size.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StoragePart | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export interface TerminalFontSizeControl {
  fontSize: number;
  increase(): void;
  decrease(): void;
  reset(): void;
  canIncrease: boolean;
  canDecrease: boolean;
  /** False when already at the default size (lets the UI disable Reset). */
  canReset: boolean;
}

/**
 * Owns the terminal font size for the whole app: initialized from the persisted value and
 * re-persisted on every change (storage injectable for tests). Lifting it here lets the SETTINGS
 * panel drive the A- / A+ controls while TerminalView (rendered elsewhere) reflects the same value.
 * State updates use the functional form so rapid clicks never act on a stale size.
 */
export function useTerminalFontSize(
  storage: StoragePart | null = defaultStorage(),
): TerminalFontSizeControl {
  const [fontSize, setFontSize] = useState(() => loadTerminalFontSize(storage));

  const apply = useCallback(
    (next: (prev: number) => number) => {
      setFontSize((prev) => {
        const value = next(prev);
        if (value === prev) return prev;
        saveTerminalFontSize(storage, value);
        return value;
      });
    },
    [storage],
  );

  const increase = useCallback(
    () => apply((prev) => stepTerminalFontSize(prev, 1)),
    [apply],
  );
  const decrease = useCallback(
    () => apply((prev) => stepTerminalFontSize(prev, -1)),
    [apply],
  );
  const reset = useCallback(
    () => apply(() => DEFAULT_TERMINAL_FONT_SIZE),
    [apply],
  );

  return {
    fontSize,
    increase,
    decrease,
    reset,
    canIncrease: canIncreaseTerminalFontSize(fontSize),
    canDecrease: canDecreaseTerminalFontSize(fontSize),
    canReset: fontSize !== DEFAULT_TERMINAL_FONT_SIZE,
  };
}
