import { type FileListResponse, fileListResponseSchema } from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The REST the quick-open palette calls to list openable files. Tests inject a fake. */
export interface FilesListApi {
  list(): Promise<FileListResponse>;
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

export function createFilesListApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): FilesListApi {
  return {
    async list() {
      const res = await fetchFn(`${base}/api/files`, {
        headers: authHeaders(token),
      });
      if (!res.ok) throw new Error(`/api/files: ${await errorOf(res)}`);
      return fileListResponseSchema.parse(await res.json());
    },
  };
}
