import type { ReactNode } from "react";

export interface PanelEmptyProps {
  /** Empty-state message (each panel supplies its own). Base design is unified via .panel-empty. */
  children: ReactNode;
}

/**
 * Shared empty-state for panels. The message varies per panel, while the base
 * design (colors, spacing, etc.) is centralized here. Rich guidance
 * (session-empty-guide) and the terminal area's hero empty state
 * (empty-main-area) serve different purposes and are out of scope.
 */
export function PanelEmpty({ children }: PanelEmptyProps) {
  return <div className="panel-empty">{children}</div>;
}
