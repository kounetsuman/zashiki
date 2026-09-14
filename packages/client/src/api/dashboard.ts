import type { FileReadResponse } from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The read REST for a local dashboard file. The path comes from the server's own config. */
export interface DashboardApi {
  read(signal?: AbortSignal): Promise<string>;
}

/** A refused read, with the status that says whether retrying today could succeed. */
export class DashboardReadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DashboardReadError";
    this.status = status;
  }
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") return body.error;
  } catch {
    // If not JSON, just the status
  }
  return `HTTP ${res.status}`;
}

export function createDashboardApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): DashboardApi {
  return {
    async read(signal) {
      const res = await fetchFn(`${base}/api/dashboard`, {
        headers: authHeaders(token),
        signal,
      });
      if (!res.ok) throw new DashboardReadError(res.status, await errorOf(res));
      const body = (await res.json()) as FileReadResponse;
      return body.content;
    },
  };
}
