import { useCallback, useState } from "react";
import { loadSelectedView, saveSelectedView, type ViewId } from "./views.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

export interface ViewSelection {
  /** The switchable view currently shown in the side column (null = none, list full-height). */
  selectedView: ViewId | null;
  handleSelectView(id: ViewId): void;
}

/** Owns which side view is shown. Reselecting the shown view closes it. */
export function useViewSelection(storage: StoragePart | null): ViewSelection {
  const [selectedView, setSelectedView] = useState(() =>
    loadSelectedView(storage),
  );

  const handleSelectView = useCallback(
    (id: ViewId): void => {
      const next = selectedView === id ? null : id;
      setSelectedView(next);
      saveSelectedView(storage, next);
    },
    [storage, selectedView],
  );

  return { selectedView, handleSelectView };
}
