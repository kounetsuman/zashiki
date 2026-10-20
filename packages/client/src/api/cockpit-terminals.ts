import {
  type CockpitTerminalLastActivityResponse,
  cockpitTerminalLastActivityResponseSchema,
  cockpitTerminalTailResponseSchema,
} from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The read REST for how long each Cockpit Terminal has been left alone and what it last showed. */
export interface CockpitTerminalsApi {
  lastActivity(
    signal?: AbortSignal,
  ): Promise<CockpitTerminalLastActivityResponse>;
  tail(cockpitTerminalId: string, signal?: AbortSignal): Promise<string[]>;
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
  };
}
