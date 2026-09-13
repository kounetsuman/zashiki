import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { isDelimitedText } from "../viewer/delimited.js";
import { renderMarkdown } from "../viewer/markdown.js";
import {
  isMarkdown,
  type MediaSource,
  type ViewerBuffer,
} from "../viewer/viewer-model.js";
import { DelimitedTable } from "./DelimitedTable.js";
import { Loading } from "./Loading.js";
import { viewerEditorExtensions } from "./viewer-editor.js";

/** The second rendering a file offers beside its text, toggled from the toolbar. */
type AlternateView = "markdownPreview" | "table";

const TOGGLE_LABEL: Record<AlternateView, { show: string; hide: string }> = {
  markdownPreview: { show: "viewer.preview", hide: "viewer.code" },
  table: { show: "viewer.table", hide: "viewer.text" },
};

function alternateView(relPath: string): AlternateView | null {
  if (isMarkdown(relPath)) return "markdownPreview";
  if (isDelimitedText(relPath)) return "table";
  return null;
}

export interface ViewerProps {
  buffer: ViewerBuffer;
  onTogglePreview(): void;
  /** The copy button at the header's left edge copies the file's absolute path. */
  onCopyPath(): void;
  /**
   * Request counter for focusing the viewer. Each time it changes, focuses the section.
   * App bumps it when a file is opened so opening a file focuses the viewer even on re-open
   * of the same file.
   */
  focusNonce?: number;
  /** 1-based line to scroll to and select once content is ready (from search / quick-open). */
  revealLine?: number;
  /** Bumped alongside revealLine so the same line can be re-revealed on a re-open. */
  revealNonce?: number;
  /** Called once a pending reveal has been applied, so the owner can clear it (no re-scroll on remount). */
  onRevealed?(): void;
}

/**
 * The CodeMirror instance (read-only; it just displays content). When polling
 * changes the content, the doc is swapped out. Editing is disabled, so cursor
 * position is not a concern.
 */
function CodeMirrorHost({
  buffer,
  revealLine,
  revealNonce,
  onRevealed,
}: Pick<ViewerProps, "buffer" | "revealLine" | "revealNonce" | "onRevealed">) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const revealedRef = useRef<number | undefined>(undefined);
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
        extensions: viewerEditorExtensions(language),
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

  // Scroll to and select the requested line once the doc is populated. Keyed on revealNonce so a
  // re-open with the same line re-scrolls, while content polling (buffer.content) never re-scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: buffer.content is a re-run trigger so the scroll can fire once the async read populates the doc.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || revealNonce === undefined || revealLine === undefined)
      return;
    if (revealedRef.current === revealNonce) return;
    const lineNo = Math.min(Math.max(revealLine, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNo);
    revealedRef.current = revealNonce;
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    onRevealed?.();
  }, [revealNonce, revealLine, buffer.content, onRevealed]);

  return <div className="viewer-cm" ref={hostRef} />;
}

function MediaHost({
  media,
  relPath,
}: {
  media: MediaSource;
  relPath: string;
}) {
  if (media.kind === "video") {
    return (
      // biome-ignore lint/a11y/useMediaCaption: local media preview has no caption track
      <video className="viewer-media" src={media.url} controls>
        {relPath}
      </video>
    );
  }
  return <img className="viewer-media" src={media.url} alt={relPath} />;
}

/**
 * File viewer. Overlays the main-area body only while the viewer tab in the
 * unified tab bar is active. Displays read-only via CodeMirror 6 (line numbers,
 * extension-based syntax highlighting, one-dark); Markdown toggles between code
 * and preview. File editing is delegated to claude code and is not done here
 * (realtime updates come from polling on the App side).
 */
export function Viewer({
  buffer,
  onTogglePreview,
  onCopyPath,
  focusNonce = 0,
  revealLine,
  revealNonce,
  onRevealed,
}: ViewerProps) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLElement | null>(null);
  const alternate = alternateView(buffer.relPath);
  const showAlternate = alternate !== null && buffer.preview;
  const previewHtml = useMemo(
    () =>
      showAlternate && alternate === "markdownPreview"
        ? renderMarkdown(buffer.content ?? "")
        : "",
    [showAlternate, alternate, buffer.content],
  );

  // Focus the content (not the section) so the find keymap (Cmd+F) reaches the editor, and
  // so the keys that scroll reach whichever element owns the scroll. Also re-run on status: a first (uncached) open mounts the editor only once
  // the read resolves, after the nonce bump, so focus must land then too. Preview
  // and media fall back to the section (no editor). preventScroll avoids fighting
  // a pending reveal-line scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusNonce / buffer.status are re-run triggers, not read in the body.
  useEffect(() => {
    const content = sectionRef.current?.querySelector<HTMLElement>(
      ".cm-content, .delimited-table",
    );
    (content ?? sectionRef.current)?.focus({ preventScroll: true });
  }, [focusNonce, buffer.status]);

  function readyContent() {
    if (buffer.media !== undefined)
      return <MediaHost media={buffer.media} relPath={buffer.relPath} />;
    if (showAlternate && alternate === "markdownPreview")
      return (
        // markdown-it escapes raw HTML with html:false (mitigates XSS).
        <div
          className="viewer-preview markdown-body"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: rendering already sanitized by markdown-it(html:false)
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      );
    if (showAlternate && alternate === "table")
      return (
        <DelimitedTable
          relPath={buffer.relPath}
          content={buffer.content ?? ""}
        />
      );
    return (
      <CodeMirrorHost
        buffer={buffer}
        revealLine={revealLine}
        revealNonce={revealNonce}
        onRevealed={onRevealed}
      />
    );
  }

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="viewer-view"
      aria-label={t("viewer.viewerLabel", { path: buffer.relPath })}
    >
      <div className="viewer-toolbar">
        <button
          type="button"
          className="viewer-copy"
          aria-label={t("viewer.copyPathLabel")}
          title={t("common.copyAbsPath")}
          onClick={onCopyPath}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            content_copy
          </span>
        </button>
        <span className="viewer-path" title={buffer.relPath}>
          {buffer.relPath}
        </span>
        {alternate !== null && (
          <button
            type="button"
            className={`viewer-toggle${showAlternate ? " is-active" : ""}`}
            aria-pressed={showAlternate}
            onClick={onTogglePreview}
          >
            {t(TOGGLE_LABEL[alternate][showAlternate ? "hide" : "show"])}
          </button>
        )}
      </div>
      <div className="viewer-body">
        {buffer.status === "loading" && <Loading />}
        {buffer.status === "error" && (
          <div className="viewer-message viewer-error" role="alert">
            {t("viewer.openFailed", { error: buffer.error })}
          </div>
        )}
        {buffer.status === "ready" && readyContent()}
      </div>
    </section>
  );
}
