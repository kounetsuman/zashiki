type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** How Tab / Shift+Tab indent lines in the clipboard-edit textarea. */
export interface IndentSetting {
  useTab: boolean;
  /** Spaces per indent level; also the width Shift+Tab strips from space-indented lines. */
  spaceCount: number;
}

/** localStorage keys for the indent unit ("1"/"0") and the space width (an integer). */
export const CLIPBOARD_INDENT_USE_TAB_KEY = "zk.clipboardEdit.indentUseTab";
export const CLIPBOARD_INDENT_SPACE_COUNT_KEY =
  "zk.clipboardEdit.indentSpaceCount";

export const MIN_SPACE_COUNT = 1;
export const MAX_SPACE_COUNT = 8;
export const DEFAULT_INDENT_SETTING: IndentSetting = {
  useTab: false,
  spaceCount: 2,
};

export interface TextSelection {
  value: string;
  start: number;
  end: number;
}

const clampSpaceCount = (n: number): number =>
  Math.min(MAX_SPACE_COUNT, Math.max(MIN_SPACE_COUNT, n));

export function indentUnit(setting: IndentSetting): string {
  return setting.useTab ? "\t" : " ".repeat(setting.spaceCount);
}

/**
 * Line starts intersected by the selection, mirroring an editor's block indent: an empty selection
 * touches its own line, and a selection ending exactly at a line's start does not reach that line.
 */
function selectedLineStarts(
  value: string,
  start: number,
  end: number,
): number[] {
  const firstLineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lastPos = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const starts: number[] = [];
  for (let ls = firstLineStart; ; ) {
    starts.push(ls);
    const nl = value.indexOf("\n", ls);
    if (nl === -1 || nl >= lastPos) break;
    ls = nl + 1;
  }
  return starts;
}

/**
 * Tab: with a selection, prepend one indent unit to every line it touches; with none, insert a unit
 * at the caret. The returned selection keeps covering the same lines so Tab can be repeated.
 */
export function indentSelection(
  sel: TextSelection,
  setting: IndentSetting,
): TextSelection {
  const unit = indentUnit(setting);
  if (sel.start === sel.end) {
    const value =
      sel.value.slice(0, sel.start) + unit + sel.value.slice(sel.start);
    const caret = sel.start + unit.length;
    return { value, start: caret, end: caret };
  }
  const starts = selectedLineStarts(sel.value, sel.start, sel.end);
  let value = sel.value;
  for (let i = starts.length - 1; i >= 0; i--) {
    const p = starts[i];
    value = value.slice(0, p) + unit + value.slice(p);
  }
  const start = sel.start === starts[0] ? sel.start : sel.start + unit.length;
  const end = sel.end + unit.length * starts.length;
  return { value, start, end };
}

function leadingIndentWidth(
  value: string,
  at: number,
  spaceCount: number,
): number {
  if (value[at] === "\t") return 1;
  let n = 0;
  while (n < spaceCount && value[at + n] === " ") n++;
  return n;
}

/**
 * Shift+Tab: strip one indent level (a leading tab, or up to `spaceCount` leading spaces) from the
 * head of every touched line, leaving lines that have no leading whitespace untouched.
 */
export function outdentSelection(
  sel: TextSelection,
  setting: IndentSetting,
): TextSelection {
  const starts = selectedLineStarts(sel.value, sel.start, sel.end);
  const firstLineStart = starts[0] ?? sel.start;
  let value = sel.value;
  let removedFirst = 0;
  let removedTotal = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const p = starts[i];
    if (p === undefined) continue;
    const width = leadingIndentWidth(value, p, setting.spaceCount);
    if (width === 0) continue;
    value = value.slice(0, p) + value.slice(p + width);
    removedTotal += width;
    if (i === 0) removedFirst = width;
  }
  const start = Math.max(firstLineStart, sel.start - removedFirst);
  const end = Math.max(start, sel.end - removedTotal);
  return { value, start, end };
}

export function loadIndentSetting(storage: StoragePart | null): IndentSetting {
  const useTab = storage?.getItem(CLIPBOARD_INDENT_USE_TAB_KEY) === "1";
  const raw = storage?.getItem(CLIPBOARD_INDENT_SPACE_COUNT_KEY);
  const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10);
  const spaceCount = Number.isFinite(parsed)
    ? clampSpaceCount(parsed)
    : DEFAULT_INDENT_SETTING.spaceCount;
  return { useTab, spaceCount };
}

export function saveIndentSetting(
  storage: StoragePart | null,
  setting: IndentSetting,
): void {
  storage?.setItem(CLIPBOARD_INDENT_USE_TAB_KEY, setting.useTab ? "1" : "0");
  storage?.setItem(
    CLIPBOARD_INDENT_SPACE_COUNT_KEY,
    String(clampSpaceCount(setting.spaceCount)),
  );
}
