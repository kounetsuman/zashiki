import { z } from "zod";

/**
 * Types for the editor's file read/write REST API. Actual fs access happens on the
 * server/infra side, and path validation uses the same three-layer defense as the explorer (fs-routes)
 * (scanRepos allowlist -> isSafeRepoRelativePath -> realpath escape detection).
 * GET  /api/file?repoPath=<abs>&file=<rel>[&encoding=<TextEncoding>][&limit=<bytes>] → the text, streamed as
 *      UTF-8, with its version as the ETag; `If-None-Match: <version>` → 304 while unchanged (unknown
 *      encoding → 400). Over `fileSizeLimits.maxBytes`, or `limit` when lower → 413 `{ error, size }`
 * POST /api/file（body = FileWriteRequest）  → FileWriteResponse
 */

/** The encodings a file read can decode with (`encoding` on GET /api/file; UTF-8 when omitted). */
export const TEXT_ENCODINGS = ["utf8", "shift_jis", "euc_jp"] as const;

export type TextEncoding = (typeof TEXT_ENCODINGS)[number];

export const fileWriteRequestSchema = z.object({
  repoPath: z.string().min(1),
  file: z.string().min(1),
  content: z.string(),
});

export type FileWriteRequest = z.infer<typeof fileWriteRequestSchema>;

export interface FileReadResponse {
  content: string;
}

export interface FileWriteResponse {
  ok: true;
}
