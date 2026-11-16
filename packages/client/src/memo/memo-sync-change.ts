/**
 * The edit that turns the editor's text into text arriving from the server (pure functions). Only
 * the span that differs is replaced, so carets and the scroll anchor outside it stay put — a
 * whole-document replacement would map every position to the start.
 */

export interface MemoSyncChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** The smallest single replacement from `current` to `incoming`, or null when they are equal. */
export function memoSyncChange(
  current: string,
  incoming: string,
): MemoSyncChange | null {
  if (current === incoming) return null;
  const shorter = Math.min(current.length, incoming.length);
  let prefix = 0;
  while (prefix < shorter && current[prefix] === incoming[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    current[current.length - 1 - suffix] ===
      incoming[incoming.length - 1 - suffix]
  )
    suffix++;
  return {
    from: prefix,
    to: current.length - suffix,
    insert: incoming.slice(prefix, incoming.length - suffix),
  };
}

/** Where a position lands after the change: same offset inside it, clamped to what was inserted. */
export function keepThroughSync(pos: number, change: MemoSyncChange): number {
  if (pos <= change.from) return pos;
  if (pos >= change.to)
    return pos - change.to + change.from + change.insert.length;
  return Math.min(pos, change.from + change.insert.length);
}
