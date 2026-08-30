import type { FileReadResponse } from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";
import { mediaUrl } from "../lib/url.js";

/** The file read REST the viewer calls (read-only). */
export interface FilesApi {
  /** Reads the content of a repo-relative file (signal allows timeout/abort). */
  read(repoPath: string, file: string, signal?: AbortSignal): Promise<string>;
  /** URL streaming the file's raw bytes for `<img>` / `<video>` (token in the query). */
  mediaUrl(repoPath: string, file: string): string;
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

export function createFilesApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): FilesApi {
  return {
    async read(repoPath, file, signal) {
      const q = new URLSearchParams({ repoPath, file });
      const res = await fetchFn(`${base}/api/file?${q.toString()}`, {
        headers: authHeaders(token),
        signal,
      });
      if (!res.ok) throw new Error(await errorOf(res));
      const body = (await res.json()) as FileReadResponse;
      return body.content;
    },
    mediaUrl(repoPath, file) {
      return mediaUrl(base, repoPath, file, token);
    },
  };
}
