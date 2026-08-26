import {
  type FsListResponse,
  type FsReposResponse,
  fsListResponseSchema,
  fsRenameResponseSchema,
  fsReposResponseSchema,
} from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The REST the explorer view calls (read plus the context-menu mutations). */
export interface FsApi {
  /** Tree root = all repos in repos.conf. */
  repos(): Promise<FsReposResponse>;
  /** Lists a single level directly under repoPath's dir (dir="" = root). */
  list(repoPath: string, dir: string): Promise<FsListResponse>;
  /** Shows a repo entry in the OS file manager (best-effort). */
  reveal(repoPath: string, path: string): Promise<void>;
  /** Renames an entry within its parent directory; resolves to its new repo-relative path. */
  rename(repoPath: string, path: string, newName: string): Promise<string>;
  /** Moves an entry to the OS trash (recoverable). */
  delete(repoPath: string, path: string): Promise<void>;
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
  const post = async (path: string, body: unknown): Promise<Response> => {
    const res = await fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${await errorOf(res)}`);
    return res;
  };
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
    async reveal(repoPath, path) {
      await post("/api/fs/reveal", { repoPath, path });
    },
    async rename(repoPath, path, newName) {
      const res = await post("/api/fs/rename", { repoPath, path, newName });
      return fsRenameResponseSchema.parse(await res.json()).newPath;
    },
    async delete(repoPath, path) {
      await post("/api/fs/delete", { repoPath, path });
    },
  };
}
