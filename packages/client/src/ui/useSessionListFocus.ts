import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import {
  buildVisibleItems,
  type FocusTarget,
  focusKey,
  nextFocusTarget,
} from "./session-list-model.js";

export interface SessionListFocus {
  focused: FocusTarget | null;
  setFocused(target: FocusTarget | null): void;
  focusedRef: React.RefObject<HTMLButtonElement | null>;
  /** Keys of the flat visible sequence, for the Enter handler's in-view check. */
  visibleKeys: string[];
  moveFocus(delta: number): void;
}

/**
 * The ↑↓ focus ring across the flat sequence of org headers and their visible rows. Separate from
 * selection (terminal switching); committed with Enter. The ring clears when its target scrolls out of
 * the visible set (row removal/collapse, a detected org dropping out) and scrolls into view as it moves.
 */
export function useSessionListFocus(
  orgList: string[],
  sessions: CockpitTerminalInfo[],
  collapsed: ReadonlySet<string>,
  selectedCockpitTerminalId: string | null,
): SessionListFocus {
  const [focused, setFocused] = useState<FocusTarget | null>(null);
  const focusedRef = useRef<HTMLButtonElement | null>(null);
  const visibleItems = buildVisibleItems(orgList, sessions, collapsed);
  const visibleKeys = visibleItems.map(focusKey);
  // The array is regenerated every render and can't be an effect dep, so hold a stable (string) form.
  // The separator is a control character that never appears in org names/cockpitTerminalIds (avoids key-boundary collisions).
  const visibleKey = visibleKeys.join("\x1f");

  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleKey is the stable representation of the visible set (visibleKeys is regenerated every render)
  useEffect(() => {
    if (focused !== null && !visibleKeys.includes(focusKey(focused)))
      setFocused(null);
  }, [visibleKey, focused]);

  useEffect(() => {
    if (focused !== null)
      focusedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);

  const moveFocus = (delta: number): void => {
    if (visibleItems.length === 0) return;
    setFocused(
      nextFocusTarget(
        visibleItems,
        focused,
        selectedCockpitTerminalId,
        sessions,
        delta,
      ),
    );
  };

  return { focused, setFocused, focusedRef, visibleKeys, moveFocus };
}
