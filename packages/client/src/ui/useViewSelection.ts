import { type FocusEvent, useCallback, useState } from "react";
import { loadSelectedView, saveSelectedView, type ViewId } from "./views.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

export interface ViewSelection {
  /** The switchable view currently shown in the side column (null = none, list full-height). */
  selectedView: ViewId | null;
  /** Identifier of the focus-holding view; inactive views dim against it. */
  activeView: string;
  handleViewFocus(e: FocusEvent<HTMLElement>): void;
  handleSelectView(id: ViewId): void;
}

/**
 * Owns which side view is shown and which view currently holds focus. Reselecting the shown
 * view closes it. activeView follows the selection so the sole shown view never dims, even on
 * keyboard switches that do not move focus.
 */
export function useViewSelection(storage: StoragePart | null): ViewSelection {
  const [selectedView, setSelectedView] = useState(() =>
    loadSelectedView(storage),
  );
  const [activeView, setActiveView] = useState("main");

  const handleViewFocus = useCallback((e: FocusEvent<HTMLElement>): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
    const id = el?.dataset.view;
    if (id !== undefined && id !== "") setActiveView(id);
  }, []);

  const handleSelectView = useCallback(
    (id: ViewId): void => {
      const next = selectedView === id ? null : id;
      setSelectedView(next);
      saveSelectedView(storage, next);
      setActiveView(next ?? "sessions");
    },
    [storage, selectedView],
  );

  return { selectedView, activeView, handleViewFocus, handleSelectView };
}
