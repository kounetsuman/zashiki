import type { ReactNode } from "react";

export interface ViewHeaderProps {
  /** View name shown on the left (e.g. SOURCE CONTROL). Uppercasing is handled by .view-title (CSS). */
  title: string;
  /** Actions placed on the right side of the header (refresh button, etc.). Omit if none. */
  children?: ReactNode;
  /** Extra modifier class appended to view-header (for view-specific styling). Omit if none. */
  className?: string;
}

/**
 * Header row shared by all views. Centralizes the contents of the header that
 * stays fixed under the "non-scrolling root + inner scroll container" layout,
 * eliminating copy-paste duplication across views.
 */
export function ViewHeader({ title, children, className }: ViewHeaderProps) {
  return (
    <header className={className ? `view-header ${className}` : "view-header"}>
      <span className="view-title">{title}</span>
      {children}
    </header>
  );
}
