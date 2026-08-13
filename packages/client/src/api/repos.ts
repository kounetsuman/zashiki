import {
  type AddRepoResponse,
  addRepoResponseSchema,
  type FsListResponse,
  type FsValidateResponse,
  fsListResponseSchema,
  fsValidateResponseSchema,
  type ReposListResponse,
  reposListResponseSchema,
} from "@zashiki/shared";

import { authHeaders } from "../lib/token.js";

/** The REST the "add org" modal calls. Tests inject a fake fetch. */
export interface ReposApi {
  /** Register a directory as a new org root. Resolves to the added org name. */
  add(path: string, color?: string): Promise<AddRepoResponse>;
  /** Previews whether `path` could be added, so the modal can hint inline before submit. */
  validate(path: string, signal?: AbortSignal): Promise<FsValidateResponse>;
  /** Directory-completion candidates for the in-progress `path` (subdirs of its parent). */
  browse(path: string, signal?: AbortSignal): Promise<FsListResponse>;
  /** The org roots currently registered in repos.conf (name + absolute path). */
  list(signal?: AbortSignal): Promise<ReposListResponse>;
}

/** Error thrown by {@link ReposApi.add}. `code` is the server's stable reason (localized by the UI). */
export class ReposAddError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ReposAddError";
    this.code = code;
  }
}

async function errorOf(
  res: Response,
): Promise<{ message: string; code?: string }> {
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (typeof body.error === "string") {
      return { message: body.error, code: body.code };
    }
  } catch {
    // If not JSON, just the status
  }
  return { message: `HTTP ${res.status}` };
}

export function createReposApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): ReposApi {
  return {
    async add(path, color) {
      const res = await fetchFn(`${base}/api/repos/add`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(color === undefined ? { path } : { path, color }),
      });
      if (!res.ok) {
        const { message, code } = await errorOf(res);
        throw new ReposAddError(message, code);
      }
      return addRepoResponseSchema.parse(await res.json());
    },
    async validate(path, signal) {
      const res = await fetchFn(
        `${base}/api/fs/validate?path=${encodeURIComponent(path)}`,
        { headers: authHeaders(token), signal },
      );
      if (!res.ok) {
        const { message, code } = await errorOf(res);
        throw new ReposAddError(message, code);
      }
      return fsValidateResponseSchema.parse(await res.json());
    },
    async browse(path, signal) {
      const res = await fetchFn(
        `${base}/api/fs/browse?path=${encodeURIComponent(path)}`,
        { headers: authHeaders(token), signal },
      );
      if (!res.ok) {
        const { message, code } = await errorOf(res);
        throw new ReposAddError(message, code);
      }
      return fsListResponseSchema.parse(await res.json());
    },
    async list(signal) {
      const res = await fetchFn(`${base}/api/repos/list`, {
        headers: authHeaders(token),
        signal,
      });
      if (!res.ok) {
        const { message, code } = await errorOf(res);
        throw new ReposAddError(message, code);
      }
      return reposListResponseSchema.parse(await res.json());
    },
  };
}
