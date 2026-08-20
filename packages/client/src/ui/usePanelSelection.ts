import { type FocusEvent, useCallback, useState } from "react";
import {
  loadSelectedPanel,
  type PanelId,
  saveSelectedPanel,
} from "./panels.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

export interface PanelSelection {
  /** The switchable panel currently shown in the side column (null = none, list full-height). */
  selectedPanel: PanelId | null;
  /** Identifier of the focus-holding panel; inactive panels dim against it. */
  activePanel: string;
  handlePanelFocus(e: FocusEvent<HTMLElement>): void;
  handleSelectPanel(id: PanelId): void;
}

/**
 * Owns which side panel is shown and which panel currently holds focus. Reselecting the shown
 * panel closes it. activePanel follows the selection so the sole shown panel never dims, even on
 * keyboard switches that do not move focus.
 */
export function usePanelSelection(storage: StoragePart | null): PanelSelection {
  const [selectedPanel, setSelectedPanel] = useState(() =>
    loadSelectedPanel(storage),
  );
  const [activePanel, setActivePanel] = useState("main");

  const handlePanelFocus = useCallback((e: FocusEvent<HTMLElement>): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-panel]");
    const id = el?.dataset.panel;
    if (id !== undefined && id !== "") setActivePanel(id);
  }, []);

  const handleSelectPanel = useCallback(
    (id: PanelId): void => {
      const next = selectedPanel === id ? null : id;
      setSelectedPanel(next);
      saveSelectedPanel(storage, next);
      setActivePanel(next ?? "sessions");
    },
    [storage, selectedPanel],
  );

  return { selectedPanel, activePanel, handlePanelFocus, handleSelectPanel };
}
