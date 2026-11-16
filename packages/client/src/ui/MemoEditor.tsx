import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, scrollPastEnd } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { IndentSetting } from "../lib/clipboard-edit-indent.js";
import { type MemoStatus, memoStatus } from "../lib/memo-status.js";
import { type MemoBuffer, memoDirty } from "../memo/memo-model.js";
import { keepThroughSync, memoSyncChange } from "../memo/memo-sync-change.js";
import {
  clampMemoViewState,
  type MemoViewState,
} from "../memo/memo-view-state.js";
import { editorIndent } from "./editor-indent.js";
import { editorSearch } from "./editor-search-panel.js";
import { useClipboardIndentSetting } from "./useClipboardIndentSetting.js";

/** Marks a transaction that applies text from the server, which is not a local edit. */
const fromServer = Annotation.define<boolean>();

/**
 * Applies text from the server in place: carets stay where the reader left them, CodeMirror keeps
 * the top visible line in view, and the change stays out of the undo history so undo cannot revert
 * the other client's save.
 */
function applyServerText(view: EditorView, text: string): void {
  const { state } = view;
  const current = state.doc.toString();
  if (current === text) return;
  // Compared as CodeMirror's own text, whose line breaks are always \n, so a CRLF memo matches.
  const change = memoSyncChange(current, state.toText(text).toString());
  if (change === null) return;
  view.dispatch({
    changes: change,
    selection: EditorSelection.create(
      state.selection.ranges.map((range) =>
        EditorSelection.range(
          keepThroughSync(range.anchor, change),
          keepThroughSync(range.head, change),
        ),
      ),
      state.selection.mainIndex,
    ),
    annotations: [fromServer.of(true), Transaction.addToHistory.of(false)],
  });
}

/** Resolve CodeMirror's selection offsets into the line/column primitives {@link memoStatus} needs. */
function readMemoStatus(state: EditorState): MemoStatus {
  const { doc } = state;
  const head = state.selection.main.head;
  const headLine = doc.lineAt(head);
  const ranges = state.selection.ranges.map((range) => {
    const toLine = doc.lineAt(range.to);
    return {
      length: range.to - range.from,
      fromLine: doc.lineAt(range.from).number,
      toLine: toLine.number,
      endsAtLineStart: !range.empty && range.to === toLine.from,
    };
  });
  return memoStatus(
    { line: headLine.number, col: head - headLine.from + 1 },
    ranges,
  );
}

export interface MemoEditorProps {
  buffer: MemoBuffer;
  /** Every keystroke reports the full editor text so the buffer tracks unsaved edits. */
  onChange(text: string): void;
  /** Persist the given text (Cmd-S or the Save button). */
  onSave(text: string): void;
  /** Bumped by App to focus the editor when the Memo tab is activated. */
  focusNonce?: number;
  /**
   * Scroll offset and caret, held by the caller so they outlive the editor: the Memo tab mounts it
   * only while active, so switching tabs destroys the CodeMirror view. Must be a stable ref — a new
   * one rebuilds the editor.
   */
  viewState?: RefObject<MemoViewState | null>;
}

interface CodeMirrorHostProps
  extends Pick<
    MemoEditorProps,
    "buffer" | "onChange" | "onSave" | "viewState"
  > {
  /** Indent unit for Tab / Shift+Tab, shared with the clipboard-edit modal. */
  indent: IndentSetting;
  /** Reports the caret/selection readout on load and whenever the doc or selection changes. */
  onStatusChange(status: MemoStatus): void;
}

/**
 * The editable CodeMirror instance for the Memo. Unlike the read-only Viewer, edits flow back out via
 * onChange, and Cmd-S saves. External updates (another client or an on-disk edit) are applied in
 * place by {@link applyServerText}.
 *
 * Each mount reads viewState and each unmount writes it back, so a tab switch returns to the same
 * scroll offset and caret instead of the top of the document.
 */
function CodeMirrorHost({
  buffer,
  indent,
  onChange,
  onSave,
  onStatusChange,
  viewState,
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(buffer.text);
  contentRef.current = buffer.text;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const indentRef = useRef(indent);
  indentRef.current = indent;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (v) => {
                onSaveRef.current(v.state.doc.toString());
                return true;
              },
            },
          ]),
          editorIndent(() => indentRef.current),
          editorSearch(),
          basicSetup,
          scrollPastEnd(),
          oneDark,
          language.of([]),
          EditorView.updateListener.of((u) => {
            const local = !u.transactions.some((tr) =>
              tr.annotation(fromServer),
            );
            if (u.docChanged && local)
              onChangeRef.current(u.state.doc.toString());
            if (u.docChanged || u.selectionSet)
              onStatusChangeRef.current(readMemoStatus(u.state));
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { overflow: "auto" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    // Clamped against the built doc, not the text: CodeMirror collapses CRLF, so the string is the
    // longer of the two and a selection taken from it can land past the end of the document.
    const restored =
      viewState?.current == null
        ? null
        : clampMemoViewState(viewState.current, view.state.doc.length);
    // Held until the scroll lands, so an unmount before that hands back the offset this mount was
    // given rather than the zero the scroller still reads (StrictMode's discarded first mount).
    let unrestored = restored;
    if (restored !== null) {
      view.dispatch({
        selection: { anchor: restored.anchor, head: restored.head },
      });
      // The scroller has no height until CodeMirror measures, so assigning the offset any earlier
      // would clamp it to an un-laid-out document.
      view.requestMeasure({
        read: () => undefined,
        write: () => {
          view.scrollDOM.scrollTop = restored.scrollTop;
          unrestored = null;
        },
      });
    }
    onStatusChangeRef.current(readMemoStatus(view.state));
    const desc = LanguageDescription.matchFilename(languages, "memo.md");
    let cancelled = false;
    if (desc !== null) {
      void desc.load().then((support) => {
        if (!cancelled)
          view.dispatch({ effects: language.reconfigure(support) });
      });
    }
    return () => {
      cancelled = true;
      if (viewState !== undefined) {
        const { anchor, head } = view.state.selection.main;
        viewState.current = {
          scrollTop: unrestored?.scrollTop ?? view.scrollDOM.scrollTop,
          anchor,
          head,
        };
      }
      viewRef.current = null;
      view.destroy();
    };
  }, [viewState]);

  useEffect(() => {
    const view = viewRef.current;
    if (view !== null) applyServerText(view, buffer.text);
  }, [buffer.text]);

  return <div className="memo-cm" ref={hostRef} />;
}

/**
 * The Memo editor. Overlays the main-area body while the pinned Memo tab is active. This is the only
 * editable surface in the cockpit (the Viewer/Diff stay read-only); edits are saved to
 * `<repos.conf dir>/memo.md` and broadcast so every client stays in sync.
 */
export function MemoEditor({
  buffer,
  onChange,
  onSave,
  focusNonce = 0,
  viewState,
}: MemoEditorProps) {
  const { t } = useTranslation();
  const { setting: indent } = useClipboardIndentSetting();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<MemoStatus | null>(null);
  const dirty = memoDirty(buffer);

  // preventScroll keeps the restored scroll offset: focusing the full-height content element
  // otherwise scrolls its top edge into view, landing back at the top of the document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusNonce is a re-run trigger, not read in the body.
  useEffect(() => {
    sectionRef.current
      ?.querySelector<HTMLElement>(".cm-content")
      ?.focus({ preventScroll: true });
  }, [focusNonce]);

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="memo-view"
      aria-label={t("memo.editorLabel")}
    >
      <div className="memo-toolbar">
        <span className="memo-title">{t("memo.title")}</span>
        <button
          type="button"
          className="memo-save"
          disabled={!dirty}
          onClick={() => onSave(buffer.text)}
        >
          {t("memo.save")}
        </button>
      </div>
      <div className="memo-body">
        <CodeMirrorHost
          buffer={buffer}
          indent={indent}
          onChange={onChange}
          onSave={onSave}
          onStatusChange={setStatus}
          viewState={viewState}
        />
      </div>
      <div className="memo-footer">
        {status !== null && (
          <span className="memo-status">
            {status.kind === "cursor"
              ? t("memo.status.cursor", { line: status.line, col: status.col })
              : t("memo.status.selection", {
                  lines: t("memo.status.lines", { count: status.lines }),
                  chars: t("memo.status.chars", { count: status.chars }),
                })}
          </span>
        )}
      </div>
    </section>
  );
}
