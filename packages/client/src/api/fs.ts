import {
  type FsListResponse,
  type FsReposResponse,
  fsListResponseSchema,
  fsReposResponseSchema,
} from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The read-only REST the explorer panel calls. */
export interface FsApi {
  /** Tree root = all repos in repos.conf. */
  repos(): Promise<FsReposResponse>;
  /** Lists a single level directly under repoPath's dir (dir="" = root). */
  list(repoPath: string, dir: string): Promise<FsListResponse>;
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

export function createFsApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): FsApi {
  return {
    async repos() {
      const res = await fetchFn(`${base}/api/fs/repos`, {
        headers: authHeaders(token),
      });
      if (!res.ok) throw new Error(`/api/fs/repos: ${await errorOf(res)}`);
      return fsReposResponseSchema.parse(await res.json());
    },
    async list(repoPath, dir) {
      const q = new URLSearchParams({ repoPath, dir });
      const res = await fetchFn(`${base}/api/fs/list?${q.toString()}`, {
        headers: authHeaders(token),
      });
      if (!res.ok) throw new Error(`/api/fs/list: ${await errorOf(res)}`);
      return fsListResponseSchema.parse(await res.json());
    },
  };
}
