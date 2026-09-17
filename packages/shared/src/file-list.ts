import { z } from "zod";

/**
 * Types and pure logic for the quick-open palette (Cmd+P): the file-list REST
 * shape and scope, `name:line` query parsing, and a fuzzy filter/scorer. `rg --files` is
 * run on the server; everything here is side-effect free and unit-tested
 * (`file-list.test.ts`).
 */

export const fileEntrySchema = z.object({
  org: z.string().min(1),
  repo: z.string().min(1),
  /** Absolute path of the file. */
  path: z.string().min(1),
  /** Path relative to the repo root (shown and fuzzy-matched). */
  relPath: z.string().min(1),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileListResponseSchema = z.object({
  /** True when the listing hit the cap (the UI shows a partial-results hint). */
  truncated: z.boolean(),
  /** The server's home directory, which a `~/` path query expands to. Absent for old servers. */
  home: z.string().optional(),
  files: z.array(fileEntrySchema),
});
export type FileListResponse = z.infer<typeof fileListResponseSchema>;

/**
 * What the server lists for one query: the workspace of the active terminal's `cwd` (its org, with
 * the repo containing `cwd` listed first so the cap never drops it), or — for a path query — the
 * scanned repo containing `dir`.
 */
export type FileListScope =
  | { kind: "workspace"; cwd: string | null }
  | { kind: "path"; dir: string };

/** A query naming an absolute (`/…`) or home-relative (`~/…`) path searches across orgs. */
export function isPathQuery(name: string): boolean {
  return name.startsWith("/") || name.startsWith("~/");
}

/**
 * The listing a query needs. A path query lists its directory part (through the last `/`), so the
 * listing is refetched only when the user moves to another directory, not on every keystroke.
 */
export function fileListScope(
  name: string,
  activeCwd: string | null,
): FileListScope {
  if (isPathQuery(name)) {
    return { kind: "path", dir: name.slice(0, name.lastIndexOf("/") + 1) };
  }
  return { kind: "workspace", cwd: activeCwd };
}

export interface QuickOpenQuery {
  /** The name part used for fuzzy matching (the `:line` suffix removed). */
  name: string;
  /** 1-based target line, or null when none was given. */
  line: number | null;
}

/**
 * Splits a VSCode-style quick-open query into its name and optional line, on the
 * last colon: "a/b.ts:42" -> {name:"a/b.ts", line:42}; a trailing colon with no
 * digits ("a.ts:") drops the colon with no line; a leading colon (":42") and
 * anything else is treated as a plain name (line null).
 */
export function parseQuickOpenQuery(raw: string): QuickOpenQuery {
  const trimmed = raw.trim();
  const colon = trimmed.lastIndexOf(":");
  // colon === 0 (leading colon, empty name) is treated as a plain name, not "line N in
  // every file" — an empty name would otherwise match the whole list.
  if (colon <= 0) return { name: trimmed, line: null };
  const rest = trimmed.slice(colon + 1);
  if (rest === "") return { name: trimmed.slice(0, colon), line: null };
  if (/^\d+$/.test(rest)) {
    return { name: trimmed.slice(0, colon), line: Number.parseInt(rest, 10) };
  }
  return { name: trimmed, line: null };
}

export interface ScoredFile {
  file: FileEntry;
  score: number;
  /** Indices into `relPath` that matched the query (for highlighting). */
  matches: number[];
}

const BONUS_ACTIVE_REPO = 1000;
const SCORE_MATCH = 1;
const BONUS_CONSECUTIVE = 8;
const BONUS_BOUNDARY = 10;
const BONUS_BASENAME = 4;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1] ?? "";
  if (
    prev === "/" ||
    prev === "." ||
    prev === "-" ||
    prev === "_" ||
    prev === " "
  ) {
    return true;
  }
  const cur = text[index] ?? "";
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}

/**
 * Greedy left-to-right subsequence match of `query` within `text`
 * (case-insensitive). Returns null when not a subsequence; otherwise the matched
 * indices and a score that rewards consecutive runs, word/segment boundaries, and
 * matches inside the basename.
 */
function scorePath(
  text: string,
  query: string,
): Omit<ScoredFile, "file"> | null {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const basenameStart = text.lastIndexOf("/") + 1;
  const matches: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of needle) {
    const at = hay.indexOf(ch, from);
    if (at < 0) return null;
    score += SCORE_MATCH;
    if (at === prev + 1) score += BONUS_CONSECUTIVE;
    if (isBoundary(text, at)) score += BONUS_BOUNDARY;
    if (at >= basenameStart) score += BONUS_BASENAME;
    matches.push(at);
    prev = at;
    // A surrogate pair spans two code units, so advance by the character's full length.
    from = at + ch.length;
  }
  return { score, matches };
}

function lexPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tie-break for equal scores: shorter path first (a tighter match), then lexicographic. */
function comparePaths(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return lexPaths(a, b);
}

export interface FilterOptions {
  /** The repo containing it ranks first on a name query. */
  activeCwd: string | null;
  /** What a leading `~` in a path query stands for. */
  home: string;
  limit: number;
}

function repoRootOf(file: FileEntry): string {
  return file.path.slice(0, file.path.length - file.relPath.length - 1);
}

/** The innermost listed repo root containing `cwd` (null when none does). */
function activeRepoRoot(
  files: readonly FileEntry[],
  cwd: string | null,
): string | null {
  if (cwd === null) return null;
  let best: string | null = null;
  for (const file of files) {
    const root = repoRootOf(file);
    const contains = cwd === root || cwd.startsWith(`${root}/`);
    if (contains && root.length > (best?.length ?? -1)) best = root;
  }
  return best;
}

/**
 * The absolute path a path query names, resolved the way the server resolves its directory:
 * `~` expanded, and empty, `.` and `..` segments collapsed. A trailing `/` is kept.
 */
function resolvePathQuery(query: string, home: string): string {
  const absolute = query.startsWith("~/") ? `${home}/${query.slice(2)}` : query;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const trailing = absolute.endsWith("/") && segments.length > 0 ? "/" : "";
  return `/${segments.join("/")}${trailing}`;
}

/** Scores a path query against the absolute path, keeping only the matches that fall inside `relPath`. */
function scoreAbsolutePath(
  file: FileEntry,
  query: string,
): Omit<ScoredFile, "file"> | null {
  const s = scorePath(file.path, query);
  if (s === null) return null;
  const relStart = file.path.length - file.relPath.length;
  return {
    score: s.score,
    matches: s.matches.filter((m) => m >= relStart).map((m) => m - relStart),
  };
}

/**
 * Filters and ranks files for the quick-open palette. An empty query returns all
 * files ordered active-repo-first then by path. A name query keeps files whose
 * `relPath` fuzzily contains it, boosting the active repo; a path query (`/…`,
 * `~/…`) matches the absolute path instead, with no boost. Ties break on the
 * shorter, then lexicographically smaller path. Always capped at `limit`.
 */
export function filterFiles(
  files: readonly FileEntry[],
  query: string,
  { activeCwd, home, limit }: FilterOptions,
): ScoredFile[] {
  const activeRoot = activeRepoRoot(files, activeCwd);
  const repoBoost = (file: FileEntry): number =>
    activeRoot !== null && repoRootOf(file) === activeRoot
      ? BONUS_ACTIVE_REPO
      : 0;

  if (query === "") {
    return [...files]
      .sort((a, b) => {
        const d = repoBoost(b) - repoBoost(a);
        if (d !== 0) return d;
        return lexPaths(a.relPath, b.relPath);
      })
      .slice(0, limit)
      .map((file) => ({ file, score: repoBoost(file), matches: [] }));
  }

  const pathQuery = isPathQuery(query);
  const needle = pathQuery ? resolvePathQuery(query, home) : query;
  const scored: ScoredFile[] = [];
  for (const file of files) {
    const s = pathQuery
      ? scoreAbsolutePath(file, needle)
      : scorePath(file.relPath, needle);
    if (s === null) continue;
    scored.push({
      file,
      score: pathQuery ? s.score : s.score + repoBoost(file),
      matches: s.matches,
    });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return comparePaths(a.file.relPath, b.file.relPath);
  });
  return scored.slice(0, limit);
}
