import { z } from "zod";

/**
 * Parses `git status --porcelain=v1`.
 * A pure function that never runs git. Classification rules:
 * - X column (index) non-empty -> staged; Y column (worktree) non-empty -> changed
 * - `??` (untracked) counts as one entry on the changed side
 * - Renames `old -> new` take the new path
 * - C-quoted paths (e.g. `"a\nb"`; even with core.quotepath=false, `"` and
 *   control characters are quoted) are unquoted before being returned
 */

export interface GitFileEntry {
  /** Display code: a single X/Y column character (A/M/D/R...) or "??". */
  code: string;
  path: string;
}

export interface ParsedGitStatus {
  staged: GitFileEntry[];
  changed: GitFileEntry[];
}

/** Decodes a C-quoted string (starting with `"`) and returns the position after the closing `"`. */
function parseCQuoted(s: string): { value: string; end: number } {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = 1;
  while (i < s.length && s[i] !== '"') {
    const ch = s[i] as string;
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === undefined) break;
      const simple: Record<string, number> = {
        n: 0x0a,
        t: 0x09,
        r: 0x0d,
        a: 0x07,
        b: 0x08,
        f: 0x0c,
        v: 0x0b,
        '"': 0x22,
        "\\": 0x5c,
      };
      if (next in simple) {
        bytes.push(simple[next] as number);
        i += 2;
        continue;
      }
      const octal = /^[0-7]{1,3}/.exec(s.slice(i + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8) & 0xff);
        i += 1 + octal[0].length;
        continue;
      }
      bytes.push(...encoder.encode(next));
      i += 2;
      continue;
    }
    bytes.push(...encoder.encode(ch));
    i += 1;
  }
  return {
    value: new TextDecoder("utf-8").decode(new Uint8Array(bytes)),
    end: i + 1,
  };
}

function unquoteField(s: string): string {
  return s.startsWith('"') ? parseCQuoted(s).value : s;
}

/** Extracts the path to display (the new path) from the path field, accounting for renames (` -> `). */
function pathFromField(rest: string): string {
  if (rest.startsWith('"')) {
    const { value, end } = parseCQuoted(rest);
    const remainder = rest.slice(end);
    if (remainder.startsWith(" -> ")) return unquoteField(remainder.slice(4));
    return value;
  }
  const idx = rest.indexOf(" -> ");
  if (idx >= 0) return unquoteField(rest.slice(idx + 4));
  return rest;
}

export function parseGitStatus(porcelain: string): ParsedGitStatus {
  const staged: GitFileEntry[] = [];
  const changed: GitFileEntry[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const x = line[0] as string;
    const y = line[1] as string;
    const path = pathFromField(line.slice(3));
    if (path === "") continue;
    if (x === "?") {
      changed.push({ code: "??", path });
      continue;
    }
    if (x !== " ") staged.push({ code: x, path });
    if (y !== " ") changed.push({ code: y, path });
  }
  return { staged, changed };
}

/**
 * Whether a path is safe as a repo-relative path (a pure function guarding
 * against path traversal). Rejects absolute paths, `..`/`.` segments, empty
 * segments, and NUL. Allows a single trailing slash for untracked
 * directories (`dir/`).
 */
export function isSafeRepoRelativePath(file: string): boolean {
  if (file.length === 0) return false;
  if (file.includes("\0")) return false;
  if (file.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/.test(file)) return false;
  const trimmed = file.endsWith("/") ? file.slice(0, -1) : file;
  if (trimmed.length === 0) return false;
  return trimmed
    .split("/")
    .every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// ---- REST types ----

export const gitFileEntrySchema = z.object({
  code: z.string().min(1).max(2),
  path: z.string().min(1),
});

export const repoStatusSchema = z.object({
  org: z.string().min(1),
  repo: z.string().min(1),
  /** Absolute path to the worktree (used directly as the repoPath for stage, etc.). */
  path: z.string().min(1),
  branch: z.string().min(1),
  staged: z.array(gitFileEntrySchema),
  changed: z.array(gitFileEntrySchema),
});

export type RepoStatus = z.infer<typeof repoStatusSchema>;

export const gitStatusResponseSchema = z.object({
  repos: z.array(repoStatusSchema),
});

export type GitStatusResponse = z.infer<typeof gitStatusResponseSchema>;

export interface SkippedRepo {
  index: number;
  repo?: string;
  path?: string;
}

export interface GitStatusResult {
  repos: RepoStatus[];
  /** Repos dropped by per-repo validation. Absent or empty means nothing was skipped. */
  skipped?: SkippedRepo[];
}

const gitStatusEnvelopeSchema = z.object({ repos: z.array(z.unknown()) });
const skippedIdentitySchema = z.object({
  repo: z.string().optional(),
  path: z.string().optional(),
});

/**
 * Validates the git status response per repo so one malformed entry can't blank the whole panel.
 * The envelope shape ({ repos: [...] }) is still required; a repo that fails validation is dropped
 * and reported via `skipped` (with any repo/path it carries) instead of throwing.
 */
export function parseGitStatusResponse(data: unknown): GitStatusResult {
  const { repos: entries } = gitStatusEnvelopeSchema.parse(data);
  const repos: RepoStatus[] = [];
  const skipped: SkippedRepo[] = [];
  entries.forEach((entry, index) => {
    const parsed = repoStatusSchema.safeParse(entry);
    if (parsed.success) {
      repos.push(parsed.data);
      return;
    }
    const identity = skippedIdentitySchema.safeParse(entry);
    const skip: SkippedRepo = { index };
    if (identity.success) {
      if (identity.data.repo) skip.repo = identity.data.repo;
      if (identity.data.path) skip.path = identity.data.path;
    }
    skipped.push(skip);
  });
  return { repos, skipped };
}

export const gitFileRequestSchema = z.object({
  repoPath: z.string().min(1),
  file: z.string().min(1),
});

export type GitFileRequest = z.infer<typeof gitFileRequestSchema>;

export const gitRepoRequestSchema = z.object({
  repoPath: z.string().min(1),
});

export type GitRepoRequest = z.infer<typeof gitRepoRequestSchema>;

/** Whether a string is a valid commit message (rejects empty or whitespace-only).
 * A pure function shared between the client's Commit-disable logic and the
 * server's 400 decision. */
export function isValidCommitMessage(message: string): boolean {
  return message.trim().length > 0;
}

export const gitCommitRequestSchema = z.object({
  repoPath: z.string().min(1),
  message: z.string().refine(isValidCommitMessage, "message must not be empty"),
});

export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;
