import { z } from "zod";

/**
 * Types for the editor's file read/write REST API. Actual fs access happens on the
 * server/infra side, and path validation uses the same three-layer defense as the explorer (fs-routes)
 * (scanRepos allowlist -> isSafeRepoRelativePath -> realpath escape detection).
 * GET  /api/file?repoPath=<abs>&file=<rel> → FileReadResponse
 * POST /api/file（body = FileWriteRequest）  → FileWriteResponse
 */

/** Maximum byte size of a single file handled by read/write (for the editor; huge files are rejected). */
export const FILE_MAX_BYTES = 2 * 1024 * 1024;

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
