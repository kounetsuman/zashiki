import type { SessionLink } from "@zashiki/shared";
import { useEffect, useState } from "react";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";

export const SESSION_LINKS_POLL_MS = 5_000;

const NO_LINKS: SessionLink[] = [];

/**
 * The links of the active Cockpit Terminal's Claude Session, fetched when it becomes active and
 * every poll while it stays so. A failed poll keeps the last links shown.
 */
export function useSessionLinks(
  api: Pick<CockpitTerminalsApi, "links"> | undefined,
  cockpitTerminalId: string | null,
): SessionLink[] {
  const [links, setLinks] = useState<{
    cockpitTerminalId: string;
    links: SessionLink[];
  } | null>(null);

  useEffect(() => {
    if (api === undefined || cockpitTerminalId === null) return;
    const controller = new AbortController();
    const fetchLinks = () => {
      api.links(cockpitTerminalId, controller.signal).then(
        (fresh) => {
          if (!controller.signal.aborted) {
            setLinks({ cockpitTerminalId, links: fresh });
          }
        },
        () => undefined,
      );
    };
    fetchLinks();
    const timer = setInterval(fetchLinks, SESSION_LINKS_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, cockpitTerminalId]);

  return links !== null && links.cockpitTerminalId === cockpitTerminalId
    ? links.links
    : NO_LINKS;
}
