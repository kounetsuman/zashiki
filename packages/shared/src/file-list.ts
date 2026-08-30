import { z } from "zod";

/**
 * Types and pure logic for the quick-open palette (Cmd+P): the file-list REST
 * shape, `name:line` query parsing, and a fuzzy filter/scorer. `rg --files` is
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
  files: z.array(fileEntrySchema),
});
export type FileListResponse = z.infer<typeof fileListResponseSchema>;

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

const BONUS_ACTIVE_ORG = 1000;
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
 * Greedy left-to-right subsequence match of `query` within `relPath`
 * (case-insensitive). Returns null when not a subsequence; otherwise the matched
 * indices and a score that rewards consecutive runs, word/segment boundaries, and
 * matches inside the basename.
 */
function scoreRelPath(
  relPath: string,
  query: string,
): Omit<ScoredFile, "file"> | null {
  const hay = relPath.toLowerCase();
  const needle = query.toLowerCase();
  const basenameStart = relPath.lastIndexOf("/") + 1;
  const matches: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of needle) {
    const at = hay.indexOf(ch, from);
    if (at < 0) return null;
    score += SCORE_MATCH;
    if (at === prev + 1) score += BONUS_CONSECUTIVE;
    if (isBoundary(relPath, at)) score += BONUS_BOUNDARY;
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

/**
 * Filters and ranks files for the quick-open palette. An empty query returns all
 * files ordered active-org-first then by path; a non-empty query keeps only files
 * whose `relPath` fuzzily contains it, ranked by score (with an active-org boost)
 * and stable path tie-breaks. Always capped at `limit`.
 */
export function filterFiles(
  files: readonly FileEntry[],
  query: string,
  activeOrg: string | null,
  limit: number,
): ScoredFile[] {
  const orgBoost = (org: string): number =>
    activeOrg !== null && org === activeOrg ? BONUS_ACTIVE_ORG : 0;

  if (query === "") {
    return [...files]
      .sort((a, b) => {
        const d = orgBoost(b.org) - orgBoost(a.org);
        if (d !== 0) return d;
        return lexPaths(a.relPath, b.relPath);
      })
      .slice(0, limit)
      .map((file) => ({ file, score: orgBoost(file.org), matches: [] }));
  }

  const scored: ScoredFile[] = [];
  for (const file of files) {
    const s = scoreRelPath(file.relPath, query);
    if (s === null) continue;
    scored.push({
      file,
      score: s.score + orgBoost(file.org),
      matches: s.matches,
    });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return comparePaths(a.file.relPath, b.file.relPath);
  });
  return scored.slice(0, limit);
}
