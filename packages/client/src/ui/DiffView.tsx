import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DiffBuffer } from "../diff/diff-model.js";
import { Loading } from "./Loading.js";

const COLLAPSE_UNCHANGED = { margin: 3, minSize: 4 } as const;

/** Read-only, height-bounded base for both merge editors; .cm-scroller owns the scroll. */
const readOnlyExtensions: Extension = [
  basicSetup,
  oneDark,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.theme({
    "&": { height: "100%" },
    ".cm-scroller": { overflow: "auto" },
  }),
];

/**
 * Renders old vs new with CodeMirror's merge view: `MergeView` for split (two side-by-side editors)
 * and `unifiedMergeView` for inline. CodeMirror virtualizes rows (only the visible ones hit the DOM)
 * and collapses long unchanged stretches, so even a diff near the size ceiling stays responsive.
 */
function DiffMergeHost({
  oldText,
  newText,
  layout,
}: Pick<DiffBuffer, "layout"> & { oldText: string; newText: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (layout === "split") {
      const view = new MergeView({
        parent: host,
        a: { doc: oldText, extensions: readOnlyExtensions },
        b: { doc: newText, extensions: readOnlyExtensions },
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: COLLAPSE_UNCHANGED,
      });
      return () => view.destroy();
    }
    const view = new EditorView({
      parent: host,
      doc: newText,
      extensions: [
        readOnlyExtensions,
        unifiedMergeView({
          original: oldText,
          mergeControls: false,
          gutter: true,
          syntaxHighlightDeletions: false,
          collapseUnchanged: COLLAPSE_UNCHANGED,
        }),
      ],
    });
    return () => view.destroy();
  }, [oldText, newText, layout]);

  return <div className="diff-cm" ref={hostRef} />;
}

export interface DiffViewProps {
  buffer: DiffBuffer;
  onToggleLayout(): void;
  /** The copy button at the header's left edge copies the file's absolute path. */
  onCopyPath(): void;
  /** Falls back to the external editor (for binary/too-large diffs that are not rendered). */
  onOpenInEditor(): void;
  /** Request counter for focusing the view (mirrors the Viewer). */
  focusNonce?: number;
}

/**
 * Diff tab body. Overlays the main-area body only while its tab is active. The double-click on a file
 * row in the Source Control view opens this; a binary or too-large diff is not rendered and offers the
 * external editor instead.
 */
export function DiffView({
  buffer,
  onToggleLayout,
  onCopyPath,
  onOpenInEditor,
  focusNonce = 0,
}: DiffViewProps) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLElement | null>(null);
  const { payload, layout } = buffer;

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusNonce is a re-run trigger, not read in the body.
  useEffect(() => {
    sectionRef.current?.focus();
  }, [focusNonce]);

  const renderable = payload !== null && !payload.binary && !payload.tooLarge;

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="diff-view"
      aria-label={t("diff.viewLabel", { path: buffer.relPath })}
    >
      <div className="diff-toolbar">
        <button
          type="button"
          className="diff-copy"
          aria-label={t("viewer.copyPathLabel")}
          title={t("common.copyAbsPath")}
          onClick={onCopyPath}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            content_copy
          </span>
        </button>
        <span className="diff-path" title={buffer.relPath}>
          {buffer.relPath}
        </span>
        {payload !== null && (
          <span className="diff-stat" aria-hidden="true">
            <span className="diff-stat-added">+{payload.added}</span>{" "}
            <span className="diff-stat-removed">-{payload.removed}</span>
          </span>
        )}
        {renderable && (
          <button
            type="button"
            className="diff-toggle"
            aria-pressed={layout === "split"}
            onClick={onToggleLayout}
          >
            {layout === "split" ? t("diff.unified") : t("diff.split")}
          </button>
        )}
      </div>
      <div className="diff-body">
        {buffer.status === "loading" && <Loading />}
        {buffer.status === "error" && (
          <div className="diff-message diff-error" role="alert">
            {t("diff.failed", { error: buffer.error })}
          </div>
        )}
        {buffer.status === "ready" && payload !== null && payload.binary && (
          <div className="diff-message" role="status">
            {t("diff.binary")}{" "}
            <button
              type="button"
              className="diff-open"
              onClick={onOpenInEditor}
            >
              {t("diff.openInEditor")}
            </button>
          </div>
        )}
        {buffer.status === "ready" && payload !== null && payload.tooLarge && (
          <div className="diff-message" role="status">
            {t("diff.tooLarge")}{" "}
            <button
              type="button"
              className="diff-open"
              onClick={onOpenInEditor}
            >
              {t("diff.openInEditor")}
            </button>
          </div>
        )}
        {buffer.status === "ready" && renderable && payload !== null && (
          // key=layout remounts the merge host on toggle; identical-payload polls keep the buffer
          // reference (diffLoaded) so an unchanged poll does not remount and lose scroll.
          <DiffMergeHost
            key={layout}
            oldText={payload.oldText}
            newText={payload.newText}
            layout={layout}
          />
        )}
      </div>
    </section>
  );
}
