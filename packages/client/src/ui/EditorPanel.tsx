import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import MarkdownIt from "markdown-it";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { type EditorBuffer, isMarkdown } from "../editor/editor-model.js";
import { Loading } from "./Loading.js";
import { panelClass } from "./panels.js";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

export interface EditorPanelProps {
  buffer: EditorBuffer;
  onTogglePreview(): void;
  /** The ⧉ at the header's left edge copies the file's absolute path. */
  onCopyPath(): void;
  inactive?: boolean;
}

/**
 * The CodeMirror instance (read-only; it just displays content). When polling
 * changes the content, the doc is swapped out. Editing is disabled, so cursor
 * position is not a concern.
 */
function CodeMirrorHost({ buffer }: Pick<EditorPanelProps, "buffer">) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Read the initial doc via a ref so the closure is fixed at view creation
  // time (avoid recreating the view on content changes; the content-sync effect
  // below swaps it out instead).
  const contentRef = useRef(buffer.content);
  contentRef.current = buffer.content;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: contentRef.current ?? "",
        extensions: [
          basicSetup,
          oneDark,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          language.of([]),
        ],
      }),
    });
    viewRef.current = view;
    // Infer the language from the file extension and load it asynchronously
    // (stays plain if none is found).
    const desc = LanguageDescription.matchFilename(languages, buffer.relPath);
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
    // Recreate only per relPath (do not recreate on content changes, so scroll
    // position is preserved).
  }, [buffer.relPath]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const next = buffer.content ?? "";
    if (view.state.doc.toString() === next) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
    });
  }, [buffer.content]);

  return <div className="editor-cm" ref={hostRef} />;
}

/**
 * File viewer. Overlays the conversation body only while the editor tab in the
 * unified tab bar is active. Displays read-only via CodeMirror 6 (line numbers,
 * extension-based syntax highlighting, one-dark); Markdown toggles between code
 * and preview. File editing is delegated to claude code and is not done here
 * (realtime updates come from polling on the App side).
 */
export function EditorPanel({
  buffer,
  onTogglePreview,
  onCopyPath,
  inactive,
}: EditorPanelProps) {
  const { t } = useTranslation();
  const md5 = isMarkdown(buffer.relPath);
  const showPreview = md5 && buffer.preview;
  const previewHtml = useMemo(
    () => (showPreview ? md.render(buffer.content ?? "") : ""),
    [showPreview, buffer.content],
  );

  return (
    <section
      className={panelClass("editor-panel", inactive)}
      data-panel="conversation"
      aria-label={t("editor.viewerLabel", { path: buffer.relPath })}
    >
      <div className="editor-toolbar">
        <button
          type="button"
          className="editor-copy"
          aria-label={t("editor.copyPathLabel")}
          title={t("common.copyAbsPath")}
          onClick={onCopyPath}
        >
          ⧉
        </button>
        <span className="editor-path" title={buffer.relPath}>
          {buffer.relPath}
        </span>
        {md5 && (
          <button
            type="button"
            className={`editor-toggle${showPreview ? " is-active" : ""}`}
            aria-pressed={showPreview}
            onClick={onTogglePreview}
          >
            {showPreview ? t("editor.code") : t("editor.preview")}
          </button>
        )}
      </div>
      <div className="editor-body">
        {buffer.status === "loading" && <Loading />}
        {buffer.status === "error" && (
          <div className="editor-message editor-error" role="alert">
            {t("editor.openFailed", { error: buffer.error })}
          </div>
        )}
        {buffer.status === "ready" &&
          (showPreview ? (
            // markdown-it escapes raw HTML with html:false (mitigates XSS).
            <div
              className="editor-preview markdown-body"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: rendering already sanitized by markdown-it(html:false)
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <CodeMirrorHost buffer={buffer} />
          ))}
      </div>
    </section>
  );
}
