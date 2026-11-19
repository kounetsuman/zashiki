import type { TextEncoding } from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";
import { mediaUrl } from "../lib/url.js";

/** A file's content and the version it was read at (null when the server sent none). */
export interface FileRead {
  content: string;
  version: string | null;
}

/** The file read REST the viewer calls (read-only). */
export interface FilesApi {
  /**
   * Reads a repo-relative file decoded with `encoding` (signal allows timeout/abort). Given the
   * `knownVersion` already in hand, resolves null without transferring the content while the file is unchanged.
   */
  read(
    repoPath: string,
    file: string,
    encoding: TextEncoding,
    signal?: AbortSignal,
    knownVersion?: string,
  ): Promise<FileRead | null>;
  /** URL streaming the file's raw bytes for `<img>` / `<video>` / `<audio>` / the PDF `<iframe>` (token in the query). */
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
    async read(repoPath, file, encoding, signal, knownVersion) {
      const q = new URLSearchParams({ repoPath, file, encoding });
      const headers: Record<string, string> = authHeaders(token);
      if (knownVersion !== undefined) headers["If-None-Match"] = knownVersion;
      const res = await fetchFn(`${base}/api/file?${q.toString()}`, {
        headers,
        signal,
        cache: "no-store",
      });
      if (res.status === 304) return null;
      if (!res.ok) throw new Error(await errorOf(res));
      // The server already decoded to UTF-8; a leading BOM is file content and stays.
      const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        await res.arrayBuffer(),
      );
      return { content, version: res.headers.get("ETag") };
    },
    mediaUrl(repoPath, file) {
      return mediaUrl(base, repoPath, file, token);
    },
  };
}
