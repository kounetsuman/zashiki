import {
  type CockpitTerminalLastActivityResponse,
  cockpitTerminalLastActivityResponseSchema,
  cockpitTerminalTailResponseSchema,
  type SessionEvent,
  type SessionLink,
  sessionLinksResponseSchema,
  sessionStatsResponseSchema,
} from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";
import { sessionLinkFaviconUrl } from "../lib/url.js";

/** The read REST for how long each Cockpit Terminal has been left alone, what it last showed, and
 * the links and activity of its Claude Session. */
export interface CockpitTerminalsApi {
  lastActivity(
    signal?: AbortSignal,
  ): Promise<CockpitTerminalLastActivityResponse>;
  tail(cockpitTerminalId: string, signal?: AbortSignal): Promise<string[]>;
  /** `details` adds GitHub titles and states and other sites' page titles and favicons as far as the
   * server has looked them up, and starts looking up the rest; leave it off for polls that only need
   * the count. */
  links(
    cockpitTerminalId: string,
    signal?: AbortSignal,
    options?: { details?: boolean },
  ): Promise<SessionLink[]>;
  /** What the Claude Session did, oldest first, for the Session Stats View. */
  stats(
    cockpitTerminalId: string,
    signal?: AbortSignal,
  ): Promise<SessionEvent[]>;
  /** The image URL for a link's `faviconOrigin`. */
  faviconUrl(origin: string): string;
}

export function createCockpitTerminalsApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): CockpitTerminalsApi {
  const getJson = async (path: string, signal?: AbortSignal) => {
    const res = await fetchFn(`${base}${path}`, {
      headers: authHeaders(token),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
  return {
    async lastActivity(signal) {
      return cockpitTerminalLastActivityResponseSchema.parse(
        await getJson("/api/cockpit-terminals/last-activity", signal),
      );
    },
    async tail(cockpitTerminalId, signal) {
      const query = new URLSearchParams({ id: cockpitTerminalId });
      const body = cockpitTerminalTailResponseSchema.parse(
        await getJson(`/api/cockpit-terminals/tail?${query}`, signal),
      );
      return body.lines;
    },
    async links(cockpitTerminalId, signal, options) {
      const query = new URLSearchParams({ id: cockpitTerminalId });
      if (options?.details === true) query.set("details", "1");
      const body = sessionLinksResponseSchema.parse(
        await getJson(`/api/cockpit-terminals/links?${query}`, signal),
      );
      return body.links;
    },
    async stats(cockpitTerminalId, signal) {
      const query = new URLSearchParams({ id: cockpitTerminalId });
      const body = sessionStatsResponseSchema.parse(
        await getJson(`/api/cockpit-terminals/stats?${query}`, signal),
      );
      return body.events;
    },
    faviconUrl(origin) {
      return sessionLinkFaviconUrl(base, origin, token);
    },
  };
}
