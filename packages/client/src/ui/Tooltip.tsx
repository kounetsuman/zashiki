import { type ReactNode, useState } from "react";

/**
 * Hover label for status-bar groups. Shows on mouseenter with no dwell and is anchored with
 * `position: fixed` so it escapes the footer's `overflow: hidden`. The accessible name rides on
 * `aria-label` rather than `title` so the OS tooltip doesn't stack on top of this styled one.
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
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip trigger; accessible name is on aria-label
    <span
      className={className}
      role="group"
      aria-label={label}
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
