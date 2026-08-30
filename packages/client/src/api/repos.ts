import {
  type AddRepoResponse,
  addRepoResponseSchema,
  type FsListResponse,
  type FsValidateResponse,
  fsListResponseSchema,
  fsValidateResponseSchema,
  type MemoRequest,
  type OrgAliasRequest,
  type OrgColorRequest,
  type OrgNoteRequest,
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
  /** Save an org's note (a blank `text` removes it). The updated set arrives via notes.sync. */
  setNote(org: string, text: string): Promise<void>;
  /** Set an org's color (a blank `color` resets to the automatic color). Reflected via state.sync. */
  setColor(org: string, color: string): Promise<void>;
  /** Set an org's alias (a blank `alias` resets to the org identity). Reflected via state.sync. */
  setAlias(org: string, alias: string): Promise<void>;
  /** Save the app-wide Memo. The updated text arrives via memo.sync. */
  setMemo(text: string): Promise<void>;
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
    async setNote(org, text) {
      const body: OrgNoteRequest = { org, text };
      const res = await fetchFn(`${base}/api/orgs/note`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { message, code } = await errorOf(res);
        throw new ReposAddError(message, code);
      }
    },
    async setColor(org, color) {
      const body: OrgColorRequest = { org, color } as OrgColorRequest;
      const res = await fetchFn(`${base}/api/orgs/color`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { message, code } = await errorOf(res);
        throw new ReposAddError(message, code);
      }
    },
    async setAlias(org, alias) {
      const body: OrgAliasRequest = { org, alias } as OrgAliasRequest;
      const res = await fetchFn(`${base}/api/orgs/alias`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { message, code } = await errorOf(res);
        throw new ReposAddError(message, code);
      }
    },
    async setMemo(text) {
      const body: MemoRequest = { text };
      const res = await fetchFn(`${base}/api/memo`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { message, code } = await errorOf(res);
        throw new ReposAddError(message, code);
      }
    },
  };
}
