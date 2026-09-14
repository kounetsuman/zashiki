import {
  type ChangeDesc,
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Extension,
  Prec,
  type SelectionRange,
} from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

import {
  type IndentSetting,
  indentUnit,
} from "../lib/clipboard-edit-indent.js";

/**
 * Line starts the range touches, mirroring an editor's block indent: an empty range touches its own
 * line, and a range ending exactly at a line's start does not reach that line.
 */
function touchedLineStarts(
  state: EditorState,
  range: SelectionRange,
): number[] {
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const lastNumber =
    !range.empty && range.to === last.from ? last.number - 1 : last.number;
  const starts: number[] = [];
  for (let n = first.number; n <= lastNumber; n++)
    starts.push(state.doc.line(n).from);
  return starts;
}

/** Width of one indent level at `pos`: a single tab, or up to `spaceCount` spaces. */
function leadingIndentWidth(
  state: EditorState,
  pos: number,
  spaceCount: number,
): number {
  const head = state.doc.sliceString(
    pos,
    Math.min(pos + spaceCount, state.doc.length),
  );
  if (head.startsWith("\t")) return 1;
  let width = 0;
  while (head[width] === " ") width++;
  return width;
}

/** Tab: one unit at each caret, and one at the head of every line a non-empty range touches. */
function indentChanges(
  state: EditorState,
  setting: IndentSetting,
): ChangeSpec[] {
  const unit = indentUnit(setting);
  const points = new Set<number>();
  for (const range of state.selection.ranges) {
    if (range.empty) points.add(range.head);
    else for (const start of touchedLineStarts(state, range)) points.add(start);
  }
  return [...points].map((from) => ({ from, insert: unit }));
}

/** Shift+Tab: strip one indent level from every touched line, leaving unindented lines alone. */
function outdentChanges(
  state: EditorState,
  setting: IndentSetting,
): ChangeSpec[] {
  const starts = new Set<number>();
  for (const range of state.selection.ranges)
    for (const start of touchedLineStarts(state, range)) starts.add(start);
  const changes: ChangeSpec[] = [];
  for (const from of starts) {
    const width = leadingIndentWidth(state, from, setting.spaceCount);
    if (width > 0) changes.push({ from, to: from + width });
  }
  return changes;
}

/**
 * Where a range lands after the edit. A caret rides to the far side of the unit it just inserted;
 * a non-empty range grows outward instead of shrinking, so a block that starts at a line's head
 * keeps covering the indent it just gained and can be indented again.
 */
function mapRange(range: SelectionRange, changes: ChangeDesc): SelectionRange {
  if (range.empty) return EditorSelection.cursor(changes.mapPos(range.head, 1));
  const from = changes.mapPos(range.from, -1);
  const to = changes.mapPos(range.to, 1);
  return range.anchor <= range.head
    ? EditorSelection.range(from, to)
    : EditorSelection.range(to, from);
}

/** Apply the indent edit as one change per touched line, keeping every selection range. */
function applyIndent(
  view: EditorView,
  build: (state: EditorState, setting: IndentSetting) => ChangeSpec[],
  setting: IndentSetting,
): boolean {
  const specs = build(view.state, setting);
  if (specs.length === 0) return true;
  const changes = view.state.changes(specs);
  view.dispatch({
    changes,
    selection: EditorSelection.create(
      view.state.selection.ranges.map((range) => mapRange(range, changes)),
      view.state.selection.mainIndex,
    ),
    userEvent: "input.indent",
  });
  return true;
}

/**
 * Tab / Shift+Tab block indent for the editable CodeMirror surfaces (the clipboard-edit modal and
 * the Memo). `getSetting` is read per keystroke, so switching the indent unit takes effect without
 * rebuilding the editor. High precedence keeps it ahead of any Tab binding a language mode or a
 * later extension brings in; CodeMirror's snippet keymap outranks it, so Tab still walks the fields
 * of an active snippet.
 */
export function editorIndent(getSetting: () => IndentSetting): Extension {
  return Prec.high(
    keymap.of([
      {
        key: "Tab",
        preventDefault: true,
        run: (view) => applyIndent(view, indentChanges, getSetting()),
      },
      {
        key: "Shift-Tab",
        preventDefault: true,
        run: (view) => applyIndent(view, outdentChanges, getSetting()),
      },
    ]),
  );
}
