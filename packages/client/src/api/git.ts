import {
  type GitStatusResponse,
  gitStatusResponseSchema,
} from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The REST the git panel calls. Tests inject a fake. */
export interface GitApi {
  status(): Promise<GitStatusResponse>;
  stage(repoPath: string, file: string): Promise<void>;
  unstage(repoPath: string, file: string): Promise<void>;
  stageAll(repoPath: string): Promise<void>;
  unstageAll(repoPath: string): Promise<void>;
  open(repoPath: string, file: string): Promise<void>;
  commit(repoPath: string, message: string): Promise<void>;
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

export function createGitApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): GitApi {
  const post = async (path: string, body: unknown): Promise<void> => {
    const res = await fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${await errorOf(res)}`);
  };
  return {
    async status() {
      const res = await fetchFn(`${base}/api/git/status`, {
        headers: authHeaders(token),
      });
      if (!res.ok) throw new Error(`/api/git/status: ${await errorOf(res)}`);
      return gitStatusResponseSchema.parse(await res.json());
    },
    stage: (repoPath, file) => post("/api/git/stage", { repoPath, file }),
    unstage: (repoPath, file) => post("/api/git/unstage", { repoPath, file }),
    stageAll: (repoPath) => post("/api/git/stage-all", { repoPath }),
    unstageAll: (repoPath) => post("/api/git/unstage-all", { repoPath }),
    open: (repoPath, file) => post("/api/git/open", { repoPath, file }),
    commit: (repoPath, message) =>
      post("/api/git/commit", { repoPath, message }),
  };
}
