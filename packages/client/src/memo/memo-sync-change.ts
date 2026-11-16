import { diff } from "@codemirror/merge";

export interface MemoSyncChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/**
 * The edits that turn `current` into `incoming`, one per changed stretch (none when they are equal).
 * Unchanged text between them stays untouched, so carets and the scroll anchor there keep their
 * place — a whole-document replacement would map every position to the start.
 */
export function memoSyncChanges(
  current: string,
  incoming: string,
): MemoSyncChange[] {
  if (current === incoming) return [];
  return diff(current, incoming).map((change) => ({
    from: change.fromA,
    to: change.toA,
    insert: incoming.slice(change.fromB, change.toB),
  }));
}
