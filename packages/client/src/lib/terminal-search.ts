import type { ISearchOptions } from "@xterm/addon-search";

/**
 * Pure helpers for the in-session terminal find bar. The actual searching is done by
 * @xterm/addon-search (SearchAddon); the decision logic that surrounds it lives here so it can be
 * unit-tested without a real terminal (canonical spec: terminal-search.test.ts).
 */

export interface SearchResults {
  /** Index of the active match, or -1 when there is no active match (none found, or over the highlight limit). */
  resultIndex: number;
  /** Total number of matches found. */
  resultCount: number;
}

export const EMPTY_SEARCH_RESULTS: SearchResults = {
  resultIndex: -1,
  resultCount: 0,
};

/**
 * Highlight colors for matches. matchOverviewRuler / activeMatchColorOverviewRuler are required by
 * the addon's type even though the overview ruler is not shown, so they mirror the match colors.
 */
const SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#4d4423",
  activeMatchBackground: "#d7a100",
  matchOverviewRuler: "#d7a100",
  activeMatchColorOverviewRuler: "#ffcc00",
};

/**
 * Options passed to findNext / findPrevious. `incremental` keeps the active match anchored while the
 * user is still typing (findNext only); it must be off for explicit next/previous navigation.
 */
export function buildSearchOptions(incremental: boolean): ISearchOptions {
  return { decorations: SEARCH_DECORATIONS, incremental };
}

/**
 * The 1/N counter shown in the bar. Returns null while the query is empty (nothing to count yet).
 * `current` is 1-based and 0 when there is no active match.
 */
export function matchCounter(
  query: string,
  results: SearchResults,
): { current: number; total: number } | null {
  if (query.length === 0) return null;
  return {
    current: results.resultIndex < 0 ? 0 : results.resultIndex + 1,
    total: results.resultCount,
  };
}

/**
 * 0-based buffer line to scroll to the top of the viewport so that a match sits vertically centered.
 * `matchY` is the 1-based buffer line from Terminal.getSelectionPosition().start.y. Clamped at the
 * top; the bottom clamp is left to Terminal.scrollToLine. Best-effort centering (issue #35).
 */
export function centerScrollTop(matchY: number, rows: number): number {
  return Math.max(0, matchY - 1 - Math.floor(rows / 2));
}
