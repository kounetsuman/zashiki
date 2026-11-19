import type { SessionEvent } from "@zashiki/shared";
import { useEffect, useState } from "react";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";

export const SESSION_STATS_POLL_MS = 5_000;

/**
 * The events of a Cockpit Terminal's Claude Session while `cockpitTerminalId` is set, fetched at once
 * and again a poll interval after each fetch settles. `null` until the first answer for that terminal
 * arrives; an answer arriving after the terminal changed is dropped, a failed poll keeps the last
 * events shown, and an unchanged answer keeps the same array so nothing re-renders.
 */
export function useSessionStats(
  api: Pick<CockpitTerminalsApi, "stats"> | undefined,
  cockpitTerminalId: string | null,
): SessionEvent[] | null {
  const [stats, setStats] = useState<{
    cockpitTerminalId: string;
    events: SessionEvent[];
    signature: string;
  } | null>(null);

  useEffect(() => {
    if (api === undefined || cockpitTerminalId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const fresh = await api
        .stats(cockpitTerminalId, controller.signal)
        .catch(() => null);
      if (controller.signal.aborted) return;
      if (fresh !== null) {
        const signature = JSON.stringify(fresh);
        setStats((prev) =>
          prev?.cockpitTerminalId === cockpitTerminalId &&
          prev.signature === signature
            ? prev
            : { cockpitTerminalId, events: fresh, signature },
        );
      }
      timer = setTimeout(poll, SESSION_STATS_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, cockpitTerminalId]);

  return stats !== null && stats.cockpitTerminalId === cockpitTerminalId
    ? stats.events
    : null;
}
