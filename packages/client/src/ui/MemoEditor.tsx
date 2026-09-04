import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, scrollPastEnd } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { type MemoStatus, memoStatus } from "../lib/memo-status.js";
import { type MemoBuffer, memoDirty } from "../memo/memo-model.js";
import { memoSearch } from "./memo-search-panel.js";

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
}

interface CodeMirrorHostProps
  extends Pick<MemoEditorProps, "buffer" | "onChange" | "onSave"> {
  /** Reports the caret/selection readout on load and whenever the doc or selection changes. */
  onStatusChange(status: MemoStatus): void;
}

/**
 * The editable CodeMirror instance for the Memo. Unlike the read-only Viewer, edits flow back out via
 * onChange, and Cmd-S saves. External updates (another client or an on-disk edit) swap the doc only
 * when it actually differs, so they don't disturb the cursor mid-edit.
 */
function CodeMirrorHost({
  buffer,
  onChange,
  onSave,
  onStatusChange,
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
          memoSearch(),
          basicSetup,
          scrollPastEnd(),
          oneDark,
          language.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
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
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (view.state.doc.toString() === buffer.text) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: buffer.text },
    });
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
}: MemoEditorProps) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<MemoStatus | null>(null);
  const dirty = memoDirty(buffer);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusNonce is a re-run trigger, not read in the body.
  useEffect(() => {
    sectionRef.current?.querySelector<HTMLElement>(".cm-content")?.focus();
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
          onChange={onChange}
          onSave={onSave}
          onStatusChange={setStatus}
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
