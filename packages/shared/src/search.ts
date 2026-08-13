import { z } from "zod";

/**
 * Pure functions for cross-cutting text search (the search panel).
 * ripgrep (`rg --json`) is run on the server/infra side; here we only do
 * (a) building rg args from search options and (b) parsing rg's JSON output.
 * Side-effect free; the primary target of Vitest unit tests (`search.test.ts`).
 */

// ---- REST types ----

export const searchRequestSchema = z.object({
  query: z.string().min(1),
  /** Case sensitivity (VSCode `Aa`). Defaults to smart-case. */
  matchCase: z.boolean().optional(),
  /** Whole-word match (VSCode `ab`). */
  wholeWord: z.boolean().optional(),
  /** Regex (VSCode `.*`). If false, fixed-string search. */
  regex: z.boolean().optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchMatchSchema = z.object({
  /** 1-based line number. */
  line: z.number().int().positive(),
  /** Line text (trailing newline stripped; oversized lines truncated). */
  text: z.string(),
  /** Byte offset where the match starts within the line (first submatch). */
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export type SearchMatch = z.infer<typeof searchMatchSchema>;

export const searchFileSchema = z.object({
  org: z.string().min(1),
  repo: z.string().min(1),
  /** Absolute path of the matched file. */
  path: z.string().min(1),
  /** Path relative to the repo root (for display/open). */
  relPath: z.string().min(1),
  matches: z.array(searchMatchSchema),
});

export type SearchFile = z.infer<typeof searchFileSchema>;

export const searchResponseSchema = z.object({
  /** Whether results were truncated because the limit was reached. */
  truncated: z.boolean(),
  files: z.array(searchFileSchema),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

// ---- Scan target roots (only the parts of the server's scanRepos result we need) ----

export interface ScannedRoot {
  org: string;
  repo: string;
  /** Absolute path of the working tree. */
  path: string;
}

export interface SearchLimits {
  /** Max total matches across all repos (exceeding this sets truncated). */
  maxTotal: number;
  /** Max matches per file (also passed to rg). */
  maxPerFile: number;
  /** Max retained length of a single line of text (prevents bloat from a huge single line). */
  maxBytesPerLine: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  maxTotal: 1000,
  maxPerFile: 100,
  maxBytesPerLine: 500,
};

/**
 * Build the ripgrep argument list from search options (search paths not included).
 * query is always passed as `--regexp <query>` (placing it positionally would
 * let a leading `-` be misread as a flag). Assumes no shell (server uses execFile).
 */
export function buildRgArgs(
  req: SearchRequest,
  limits: SearchLimits,
): string[] {
  const args = ["--json", "--max-count", String(limits.maxPerFile)];
  if (!req.regex) args.push("--fixed-strings");
  if (req.wholeWord) args.push("--word-regexp");
  if (req.matchCase) args.push("--case-sensitive");
  else args.push("--smart-case");
  args.push("--regexp", req.query);
  return args;
}

interface RgSubmatch {
  start?: number;
  end?: number;
}

interface RgMatchData {
  path?: { text?: string };
  lines?: { text?: string };
  line_number?: number;
  submatches?: RgSubmatch[];
}

function stripLineEnd(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function rootFor(path: string, roots: ScannedRoot[]): ScannedRoot | null {
  for (const r of roots) {
    if (path === r.path) return r;
    if (path.startsWith(`${r.path}/`)) return r;
  }
  return null;
}

/**
 * Shape the `rg --json` output (newline-delimited JSON) into a FileMatches array.
 * - Ignore lines other than `type: "match"` (begin/end/summary, non-JSON, blank).
 * - Drop paths that don't belong to a scan target root (fail-safe).
 * - Stop with truncated=true once the total match count exceeds limits.maxTotal.
 * - Preserve appearance order and bundle matches for the same file into one entry.
 */
export function parseRgJson(
  stdout: string,
  roots: ScannedRoot[],
  limits: SearchLimits,
): SearchResponse {
  const files: SearchFile[] = [];
  const byPath = new Map<string, SearchFile>();
  let total = 0;
  let truncated = false;

  for (const raw of stdout.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: { type?: string; data?: RgMatchData };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.type !== "match" || !parsed.data) continue;
    const data = parsed.data;
    const path = data.path?.text;
    const line = data.line_number;
    if (typeof path !== "string" || typeof line !== "number") continue;
    const root = rootFor(path, roots);
    if (!root) continue;

    if (total >= limits.maxTotal) {
      truncated = true;
      break;
    }
    total += 1;

    const sub = data.submatches?.[0];
    const rawText = data.lines?.text ?? "";
    const text = stripLineEnd(rawText).slice(0, limits.maxBytesPerLine);
    const match: SearchMatch = {
      line,
      text,
      start: typeof sub?.start === "number" ? sub.start : 0,
      end: typeof sub?.end === "number" ? sub.end : 0,
    };

    let file = byPath.get(path);
    if (!file) {
      const relPath =
        path === root.path ? root.repo : path.slice(root.path.length + 1);
      file = {
        org: root.org,
        repo: root.repo,
        path,
        relPath,
        matches: [],
      };
      byPath.set(path, file);
      files.push(file);
    }
    file.matches.push(match);
  }

  return { truncated, files };
}
