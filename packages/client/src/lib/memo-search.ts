/**
 * Pure helpers for the Memo find/replace widget. The searching itself is done by
 * @codemirror/search (SearchQuery); the counting logic that surrounds it lives here so it can be
 * unit-tested without an editor (canonical spec: memo-search.test.ts).
 */

export interface MemoMatchStats {
  /** 1-based index of the match that equals the primary selection, or 0 when none is selected. */
  current: number;
  /** Total number of matches in the document. */
  total: number;
}

/**
 * Count the query hits and locate the one under the primary selection. `matches` are the hit ranges
 * in document order; `selection` is the primary selection. A match "under the selection" is one whose
 * range equals it exactly — which is what findNext / findPrevious leave selected.
 */
export function memoMatchStats(
  matches: Iterable<{ from: number; to: number }>,
  selection: { from: number; to: number },
): MemoMatchStats {
  let total = 0;
  let current = 0;
  for (const match of matches) {
    total += 1;
    if (match.from === selection.from && match.to === selection.to)
      current = total;
  }
  return { current, total };
}

/**
 * The `n / m` counter text shown in the widget. Empty while the query is blank (nothing to count),
 * `noMatches` when the query finds nothing, otherwise `current / total`.
 */
export function memoMatchLabel(
  query: string,
  stats: MemoMatchStats,
  noMatches: string,
): string {
  if (query.length === 0) return "";
  if (stats.total === 0) return noMatches;
  return `${stats.current} / ${stats.total}`;
}
