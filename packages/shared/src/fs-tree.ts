import { z } from "zod";

import { stripSurroundingSlashes, stripTrailingSlashes } from "./path-slash.js";

/**
 * REST types for the explorer panel's directory listing, plus pure logic
 * for tree display (sorting and path joining).
 * Actual fs traversal lives on the server/infra (side-effecting) side; this
 * file contains only pure functions that never touch the fs.
 */

export const fsEntryKindSchema = z.enum(["dir", "file"]);
export type FsEntryKind = z.infer<typeof fsEntryKindSchema>;

export const fsEntrySchema = z.object({
  /** A single entry name within a directory (contains no path separators). */
  name: z.string().min(1),
  kind: fsEntryKindSchema,
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

export const fsListRequestSchema = z.object({
  /** Absolute path to an already-scanRepos'd worktree (checked against the allowlist). */
  repoPath: z.string().min(1),
  /** Path relative to the repo root ("" = repo root itself). */
  dir: z.string(),
});
export type FsListRequest = z.infer<typeof fsListRequestSchema>;

export const fsListResponseSchema = z.object({
  entries: z.array(fsEntrySchema),
  /** True when the listing was truncated past the limit (so the UI can show "partial only"). */
  truncated: z.boolean(),
});
export type FsListResponse = z.infer<typeof fsListResponseSchema>;

/** Explorer roots = every repo in repos.conf (a lightweight version that never runs git). */
export const fsRepoSchema = z.object({
  org: z.string().min(1),
  repo: z.string().min(1),
  /** Absolute path to the worktree (used directly as the repoPath for list). */
  path: z.string().min(1),
  /** True for a linked git worktree (vs the main working tree). Optional so version skew never drops a repo. */
  isWorktree: z.boolean().optional(),
  /**
   * Absolute path of the main working tree this repo belongs to — the key that groups a repo
   * with its linked worktrees. A main tree carries its own path here. Optional so an older
   * server (missing the field) degrades to grouping each repo on its own path.
   */
  mainPath: z.string().min(1).optional(),
});
export type FsRepo = z.infer<typeof fsRepoSchema>;

export const fsReposResponseSchema = z.object({
  repos: z.array(fsRepoSchema),
});
export type FsReposResponse = z.infer<typeof fsReposResponseSchema>;

/**
 * VSCode explorer ordering: directories first, then files, each group stably
 * sorted by name via localeCompare (case-insensitive, numeric). No side effects
 * (returns a new array).
 */
export function sortFsEntries(entries: readonly FsEntry[]): FsEntry[] {
  const collator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

/**
 * Builds a relative path by appending a child entry name to a repo-relative
 * parent directory ("" = root). Used as the key for display and the next list
 * request. Does not add leading/trailing extra `/`.
 */
export function joinRepoRelative(dir: string, name: string): string {
  const base = stripSurroundingSlashes(dir);
  return base === "" ? name : `${base}/${name}`;
}

/**
 * File name -> extension icon kind. A pure function that returns only the
 * classification key for CSS to style (emoji/SVG are the client's responsibility);
 * unknown falls back to "file". Considers both special-cased file names
 * (e.g. package.json) and the extension.
 */
export function fileIconKind(name: string): string {
  const lower = name.toLowerCase();
  const byName: Record<string, string> = {
    "package.json": "npm",
    "tsconfig.json": "ts",
    ".gitignore": "git",
    ".gitattributes": "git",
    dockerfile: "docker",
    "readme.md": "readme",
  };
  if (lower in byName) return byName[lower] as string;
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  const byExt: Record<string, string> = {
    ts: "ts",
    tsx: "ts",
    js: "js",
    jsx: "js",
    mjs: "js",
    cjs: "js",
    json: "json",
    md: "md",
    css: "css",
    html: "html",
    rs: "rust",
    toml: "toml",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    svg: "image",
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
  };
  return byExt[ext] ?? "file";
}

/** A repository and its linked worktrees, collected under one heading in the explorer. */
export interface RepoGroup {
  /** Grouping key = the shared main working tree path. */
  key: string;
  /** Heading label = the final path segment of the main working tree. */
  label: string;
  /** org shown on the heading (from the main tree when present, else the first member). */
  org: string;
  /** Members ordered: the main working tree first, then linked worktrees by name. */
  repos: FsRepo[];
}

function repoGroupKey(repo: FsRepo): string {
  return repo.mainPath ?? repo.path;
}

function baseName(path: string): string {
  const trimmed = stripTrailingSlashes(path);
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Collects each repo with its linked worktrees under the main working tree they share
 * (keyed on `mainPath`). Groups are ordered by heading label; within a group the main
 * working tree comes first, then worktrees, each by name (case-insensitive, numeric).
 * A group with a single member has no separate main tree to distinguish and is rendered flat.
 */
export function groupReposByRepository(repos: readonly FsRepo[]): RepoGroup[] {
  const collator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });
  const byKey = new Map<string, FsRepo[]>();
  for (const repo of repos) {
    const key = repoGroupKey(repo);
    const members = byKey.get(key);
    if (members) members.push(repo);
    else byKey.set(key, [repo]);
  }
  const groups: RepoGroup[] = [];
  for (const [key, members] of byKey) {
    const sorted = [...members].sort((a, b) => {
      const aMain = a.path === key;
      const bMain = b.path === key;
      if (aMain !== bMain) return aMain ? -1 : 1;
      return collator.compare(a.repo, b.repo);
    });
    const anchor = sorted.find((r) => r.path === key) ?? sorted[0];
    if (!anchor) continue;
    groups.push({
      key,
      label: baseName(key),
      org: anchor.org,
      repos: sorted,
    });
  }
  return groups.sort((a, b) => collator.compare(a.label, b.label));
}
