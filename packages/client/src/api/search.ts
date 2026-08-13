import {
  type SearchRequest,
  type SearchResponse,
  searchResponseSchema,
} from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The REST the search panel calls. Tests inject a fake. */
export interface SearchApi {
  search(req: SearchRequest): Promise<SearchResponse>;
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

export function createSearchApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): SearchApi {
  return {
    async search(req) {
      const res = await fetchFn(`${base}/api/search`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`/api/search: ${await errorOf(res)}`);
      return searchResponseSchema.parse(await res.json());
    },
  };
}
