// @vitest-environment jsdom
import {
  type ChangeDesc,
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_INDENT_SETTING,
  type IndentSetting,
} from "../lib/clipboard-edit-indent.js";
import { editorIndent } from "./editor-indent.js";

const TAB: IndentSetting = { useTab: true, spaceCount: 2 };
const SPACES4: IndentSetting = { useTab: false, spaceCount: 4 };

let view: EditorView | null = null;
let lastChanges: ChangeDesc | null = null;

function mountView(
  doc: string,
  getSetting: () => IndentSetting = () => DEFAULT_INDENT_SETTING,
  rival?: Extension,
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        rival ?? [],
        editorIndent(getSetting),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) lastChanges = u.changes;
        }),
      ],
    }),
  });
  return view;
}

function pressTab(mounted: EditorView, extra?: KeyboardEventInit): boolean {
  return mounted.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      keyCode: 9,
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  );
}

function select(mounted: EditorView, ...pairs: [number, number][]): void {
  mounted.dispatch({
    selection: EditorSelection.create(
      pairs.map(([anchor, head]) => EditorSelection.range(anchor, head)),
    ),
  });
}

function selection(mounted: EditorView): [number, number][] {
  return mounted.state.selection.ranges.map((r) => [r.from, r.to]);
}

afterEach(() => {
  view?.destroy();
  view = null;
  lastChanges = null;
});

/** Document ranges the last edit replaced, as [from, to] pairs in the pre-edit document. */
function touchedRanges(): [number, number][] {
  const ranges: [number, number][] = [];
  lastChanges?.iterChangedRanges((fromA, toA) => ranges.push([fromA, toA]));
  return ranges;
}

describe("editorIndent on Tab", () => {
  it("prepends the unit to every line the selection touches", () => {
    const mounted = mountView("a\nb\nc");
    select(mounted, [0, 5]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("  a\n  b\n  c");
  });

  it("keeps a full selection covering the indented block, so Tab repeats", () => {
    const mounted = mountView("a\nb");
    select(mounted, [0, 3]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("  a\n  b");
    expect(selection(mounted)).toEqual([[0, 7]]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("    a\n    b");
  });

  it("does not indent a trailing line that only the selection's newline reaches", () => {
    const mounted = mountView("a\nb\nc");
    select(mounted, [0, 2]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("  a\nb\nc");
  });

  it("indents only the touched lines for a mid-block selection", () => {
    const mounted = mountView("a\nb\nc\nd", () => TAB);
    select(mounted, [2, 5]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("a\n\tb\n\tc\nd");
  });

  it("inserts the unit at the caret when there is no selection", () => {
    const mounted = mountView("ab");
    select(mounted, [1, 1]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("a  b");
    expect(selection(mounted)).toEqual([[3, 3]]);
  });

  it("serves every cursor of a multi-cursor selection", () => {
    const mounted = mountView("a\nb\nc");
    select(mounted, [0, 0], [2, 2], [4, 4]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("  a\n  b\n  c");
    expect(selection(mounted)).toEqual([
      [2, 2],
      [6, 6],
      [10, 10],
    ]);
  });

  it("indents a line once when several cursors sit on it", () => {
    const mounted = mountView("abc");
    select(mounted, [0, 1], [1, 2]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("  abc");
  });
});

describe("editorIndent on Shift+Tab", () => {
  it("removes up to N leading spaces from each selected line", () => {
    const mounted = mountView("    a\n  b\nc");
    select(mounted, [0, 10]);
    pressTab(mounted, { shiftKey: true });
    expect(mounted.state.doc.toString()).toBe("  a\nb\nc");
  });

  it("removes a single leading tab regardless of the space width", () => {
    const mounted = mountView("\ta\n\tb", () => SPACES4);
    select(mounted, [0, 5]);
    pressTab(mounted, { shiftKey: true });
    expect(mounted.state.doc.toString()).toBe("a\nb");
  });

  it("leaves lines with no leading whitespace alone", () => {
    const mounted = mountView("a\nb");
    select(mounted, [0, 3]);
    pressTab(mounted, { shiftKey: true });
    expect(mounted.state.doc.toString()).toBe("a\nb");
    expect(selection(mounted)).toEqual([[0, 3]]);
  });

  it("outdents the caret's line when there is no selection", () => {
    const mounted = mountView("a\n    b\nc");
    select(mounted, [6, 6]);
    pressTab(mounted, { shiftKey: true });
    expect(mounted.state.doc.toString()).toBe("a\n  b\nc");
  });

  it("makes no edit at all when there is nothing to strip, so undo stays meaningful", () => {
    const mounted = mountView("a\nb");
    select(mounted, [0, 3]);
    pressTab(mounted, { shiftKey: true });
    expect(lastChanges).toBeNull();
  });
});

describe("editorIndent bindings", () => {
  it("indents ahead of another extension's Tab binding", () => {
    let rivalRan = false;
    const rival = keymap.of([
      {
        key: "Tab",
        run: () => {
          rivalRan = true;
          return true;
        },
      },
    ]);
    const mounted = mountView("a", () => DEFAULT_INDENT_SETTING, rival);
    select(mounted, [0, 0]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("  a");
    expect(rivalRan).toBe(false);
  });

  it("consumes the key so focus stays in the editor", () => {
    const mounted = mountView("a");
    expect(pressTab(mounted)).toBe(false);
  });

  it("edits only the indented line, so a long doc keeps its scroll position", () => {
    const mounted = mountView("a\nb\nc");
    select(mounted, [2, 3]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("a\n  b\nc");
    expect(touchedRanges()).toEqual([[2, 2]]);
  });

  it("reads the indent unit per keystroke, so switching it needs no rebuild", () => {
    let setting: IndentSetting = SPACES4;
    const mounted = mountView("a", () => setting);
    select(mounted, [0, 0]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("    a");
    setting = TAB;
    select(mounted, [0, 0]);
    pressTab(mounted);
    expect(mounted.state.doc.toString()).toBe("\t    a");
  });
});
