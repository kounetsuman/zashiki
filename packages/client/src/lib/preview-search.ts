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

/**
 * Case-insensitive, literal, non-overlapping matches of `query` across the joined segments. Each
 * whitespace run in the query matches any whitespace run, since the preview shows a source line
 * break as a space.
 */
export function locateMatches(
  segments: readonly string[],
  query: string,
): SegmentMatch[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return [];
  const starts: number[] = [];
  let joined = "";
  for (const segment of segments) {
    starts.push(joined.length);
    joined += segment;
  }
  // Matches arrive in ascending order, so one forward-only cursor maps every position.
  let segment = 0;
  const positionAt = (index: number, isEnd: boolean): SegmentPosition => {
    // An end on a boundary belongs to the segment before it, so a match never ends at offset 0.
    const startsAfter = (i: number) =>
      isEnd ? (starts[i] ?? 0) < index : (starts[i] ?? 0) <= index;
    while (segment + 1 < starts.length && startsAfter(segment + 1))
      segment += 1;
    return { segment, offset: index - (starts[segment] ?? 0) };
  };
  const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"), "giu");
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
