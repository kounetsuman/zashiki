import {
  type CockpitTerminalLastActivityResponse,
  cockpitTerminalLastActivityResponseSchema,
  cockpitTerminalTailResponseSchema,
  type SessionLink,
  sessionLinksResponseSchema,
} from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The read REST for how long each Cockpit Terminal has been left alone, what it last showed, and
 * the links its Claude Session has seen. */
export interface CockpitTerminalsApi {
  lastActivity(
    signal?: AbortSignal,
  ): Promise<CockpitTerminalLastActivityResponse>;
  tail(cockpitTerminalId: string, signal?: AbortSignal): Promise<string[]>;
  /** `details` adds GitHub titles and states as far as the server has looked them up, and starts
   * looking up the rest; leave it off for polls that only need the count. */
  links(
    cockpitTerminalId: string,
    signal?: AbortSignal,
    options?: { details?: boolean },
  ): Promise<SessionLink[]>;
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
  };
}
