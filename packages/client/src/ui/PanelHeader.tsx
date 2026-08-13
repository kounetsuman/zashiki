import type { ReactNode } from "react";

export interface PanelHeaderProps {
  /** Panel name shown on the left (e.g. SOURCE CONTROL). Uppercasing is handled by .panel-title (CSS). */
  title: string;
  /** Actions placed on the right side of the header (refresh button, etc.). Omit if none. */
  children?: ReactNode;
  /** Extra modifier class appended to panel-header (for panel-specific styling). Omit if none. */
  className?: string;
}

/**
 * Header row shared by all panels. Centralizes the contents of the header that
 * stays fixed under the "non-scrolling root + inner scroll container" layout,
 * eliminating copy-paste duplication across panels.
 */
export function PanelHeader({ title, children, className }: PanelHeaderProps) {
  return (
    <header
      className={className ? `panel-header ${className}` : "panel-header"}
    >
      <span className="panel-title">{title}</span>
      {children}
    </header>
  );
}
