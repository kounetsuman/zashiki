import type { SessionLink } from "@zashiki/shared";
import { useEffect, useState } from "react";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";

export const SESSION_LINKS_POLL_MS = 5_000;

const NO_LINKS: SessionLink[] = [];

/**
 * The links of the active Cockpit Terminal's Claude Session, fetched when it becomes active or
 * `details` changes, and again a poll interval after each fetch settles while it stays so. An answer
 * arriving after the terminal changed is dropped, and a failed poll keeps the last links shown.
 */
export function useSessionLinks(
  api: Pick<CockpitTerminalsApi, "links"> | undefined,
  cockpitTerminalId: string | null,
  details = false,
): SessionLink[] {
  const [links, setLinks] = useState<{
    cockpitTerminalId: string;
    links: SessionLink[];
  } | null>(null);

  useEffect(() => {
    if (api === undefined || cockpitTerminalId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const fresh = await api
        .links(cockpitTerminalId, controller.signal, { details })
        .catch(() => null);
      if (controller.signal.aborted) return;
      if (fresh !== null) setLinks({ cockpitTerminalId, links: fresh });
      timer = setTimeout(poll, SESSION_LINKS_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, cockpitTerminalId, details]);

  return links !== null && links.cockpitTerminalId === cockpitTerminalId
    ? links.links
    : NO_LINKS;
}
