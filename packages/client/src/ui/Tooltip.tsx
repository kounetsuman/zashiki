import { type ReactNode, useState } from "react";

/**
 * Hover label for status-bar groups. Shows on mouseenter with no dwell (native `title` never fires
 * here — the per-second footer re-render keeps resetting its dwell timer) and is anchored with
 * `position: fixed` so it escapes the footer's `overflow: hidden`.
 */
export function Tooltip({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip trigger; accessible name is on title
    <span
      className={className}
      title={label}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAnchor({ left: r.left, top: r.top });
      }}
      onMouseLeave={() => setAnchor(null)}
    >
      {children}
      {anchor !== null && (
        <span
          className="app-tooltip"
          role="tooltip"
          style={{ left: anchor.left, top: anchor.top }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
