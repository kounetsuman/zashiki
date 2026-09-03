/**
 * Pure helper for the Memo footer's cursor/selection readout. The caller resolves CodeMirror offsets
 * into line/column primitives; this decides whether to show the caret position or the selection size,
 * so the branching is unit-testable without an editor (canonical spec: memo-status.test.ts).
 */

export interface MemoCaret {
  /** 1-based line of the primary selection head. */
  line: number;
  /** 1-based column of the primary selection head. */
  col: number;
}

export interface MemoSelectedRange {
  /** Characters in the range (`to - from`). */
  length: number;
  /** 1-based line of the range start. */
  fromLine: number;
  /** 1-based line of the range end. */
  toLine: number;
  /** True when the range ends at column 1 of `toLine` (so that line holds none of the selection). */
  endsAtLineStart: boolean;
}

export type MemoStatus =
  | { readonly kind: "cursor"; readonly line: number; readonly col: number }
  | {
      readonly kind: "selection";
      readonly lines: number;
      readonly chars: number;
    };

/**
 * The caret position when nothing is selected, otherwise the size of the selection. `chars` sums every
 * range (multi-cursor ranges are disjoint, so summing never double-counts); `lines` is the count of
 * distinct physical lines any range touches, so two cursors on one line count it once. A range ending
 * at the start of a line (e.g. a whole-line selection, which runs to column 1 of the next line) does
 * not include that trailing line, matching how editors report "N lines selected".
 */
export function memoStatus(
  caret: MemoCaret,
  ranges: Iterable<MemoSelectedRange>,
): MemoStatus {
  let chars = 0;
  const selectedLines = new Set<number>();
  for (const range of ranges) {
    if (range.length === 0) continue;
    chars += range.length;
    const lastLine = range.endsAtLineStart ? range.toLine - 1 : range.toLine;
    for (let line = range.fromLine; line <= lastLine; line += 1)
      selectedLines.add(line);
  }
  if (chars === 0) return { kind: "cursor", line: caret.line, col: caret.col };
  return { kind: "selection", lines: selectedLines.size, chars };
}
