/**
 * Pure helpers for the Markdown preview find bar. The preview's text is split across many text
 * nodes (inline markup such as `**bold**` breaks a sentence apart), so matching runs over the
 * concatenated text and each match is mapped back to a (segment, offset) pair per end
 * (canonical spec: preview-search.test.ts).
 */

export interface SegmentPosition {
  segment: number;
  offset: number;
}

export interface SegmentMatch {
  start: SegmentPosition;
  end: SegmentPosition;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, literal, non-overlapping matches of `query` across the joined segments. */
export function locateMatches(
  segments: readonly string[],
  query: string,
): SegmentMatch[] {
  if (query === "") return [];
  const starts: number[] = [];
  let joined = "";
  for (const segment of segments) {
    starts.push(joined.length);
    joined += segment;
  }
  const positionAt = (index: number, isEnd: boolean): SegmentPosition => {
    // An end on a boundary belongs to the segment before it, so a match never ends at offset 0.
    let segment = 0;
    for (let i = 0; i < starts.length; i += 1) {
      const begin = starts[i] ?? 0;
      if (isEnd ? begin < index : begin <= index) segment = i;
      else break;
    }
    return { segment, offset: index - (starts[segment] ?? 0) };
  };
  const pattern = new RegExp(escapeRegExp(query), "giu");
  return Array.from(joined.matchAll(pattern), (m) => ({
    start: positionAt(m.index, false),
    end: positionAt(m.index + m[0].length, true),
  }));
}

/** The match index after moving one step, wrapping at both ends; -1 when there are no matches. */
export function stepMatchIndex(
  current: number,
  total: number,
  direction: "next" | "previous",
): number {
  if (total === 0) return -1;
  const delta = direction === "next" ? 1 : -1;
  return (((current + delta) % total) + total) % total;
}
