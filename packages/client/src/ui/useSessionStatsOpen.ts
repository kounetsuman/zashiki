import { useCallback, useState } from "react";

/**
 * Whether the Session Stats View is showing. It follows the active Cockpit Terminal, and closes as
 * soon as none is active so it cannot reappear later on its own.
 */
export function useSessionStatsOpen(activeCockpitTerminalId: string | null): {
  open: boolean;
  show(): void;
  hide(): void;
} {
  const [open, setOpen] = useState(false);
  if (open && activeCockpitTerminalId === null) setOpen(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  return { open: open && activeCockpitTerminalId !== null, show, hide };
}
