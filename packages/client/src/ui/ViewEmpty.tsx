import type { ReactNode } from "react";

export interface ViewEmptyProps {
  /** Empty-state message (each view supplies its own). Base design is unified via .view-empty. */
  children: ReactNode;
}

/**
 * Shared empty-state for views. The message varies per view, while the base
 * design (colors, spacing, etc.) is centralized here. Rich guidance
 * (session-empty-guide) and the terminal area's hero empty state
 * (empty-main-area) serve different purposes and are out of scope.
 */
export function ViewEmpty({ children }: ViewEmptyProps) {
  return <div className="view-empty">{children}</div>;
}
