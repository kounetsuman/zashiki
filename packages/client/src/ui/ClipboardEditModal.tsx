import { EditorState, Prec } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type IndentSetting,
  indentSelection,
  MAX_SPACE_COUNT,
  MIN_SPACE_COUNT,
  outdentSelection,
  type TextSelection,
} from "../lib/clipboard-edit-indent.js";
import { trimLineEndWhitespace } from "../lib/clipboard-edit-modal.js";
import { editorSearch } from "./editor-search-panel.js";
import { useClipboardIndentSetting } from "./useClipboardIndentSetting.js";
import "./ClipboardEditModal.css";

const SPACE_COUNT_OPTIONS = Array.from(
  { length: MAX_SPACE_COUNT - MIN_SPACE_COUNT + 1 },
  (_, i) => MIN_SPACE_COUNT + i,
);

export interface ClipboardEditModalProps {
  /** The just-copied selection, prefilled into the editable editor. */
  text: string;
  /** Current setting; the in-modal switch reflects and flips it (checked = "don't show again"). */
  enabled: boolean;
  onSetEnabled(enabled: boolean): void;
  onClose(): void;
}

/** Re-indent the primary selection with a clipboard-edit pure transform, replacing the whole doc. */
function applyIndent(
  view: EditorView,
  transform: (sel: TextSelection, setting: IndentSetting) => TextSelection,
  setting: IndentSetting,
): boolean {
  const { from, to } = view.state.selection.main;
  const next = transform(
    { value: view.state.doc.toString(), start: from, end: to },
    setting,
  );
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next.value },
    selection: { anchor: next.start, head: next.end },
  });
  return true;
}

/**
 * The CodeMirror editor inside the modal. It reuses the shared find/replace panel ({@link editorSearch})
 * so Ctrl+F searches here too, and drives Tab / Shift+Tab through the clipboard-edit indent helpers.
 * The live indent unit is read through a ref so flipping the radios takes effect without rebuilding
 * the editor.
 */
function ClipboardCodeMirror({
  initialDoc,
  setting,
}: {
  initialDoc: string;
  setting: IndentSetting;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const settingRef = useRef(setting);
  settingRef.current = setting;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          Prec.high(
            keymap.of([
              {
                key: "Tab",
                preventDefault: true,
                run: (v) => applyIndent(v, indentSelection, settingRef.current),
              },
              {
                key: "Shift-Tab",
                preventDefault: true,
                run: (v) =>
                  applyIndent(v, outdentSelection, settingRef.current),
              },
            ]),
          ),
          editorSearch(),
          basicSetup,
          oneDark,
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { overflow: "auto" },
          }),
        ],
      }),
    });
    view.focus();
    return () => view.destroy();
  }, [initialDoc]);

  return <div className="clip-edit-cm" ref={hostRef} />;
}

/**
 * A scratchpad for the just-copied selection so a hard-wrapped one-liner can be rejoined by hand and
 * re-copied manually before pasting. The dialog never writes to the clipboard itself: the button,
 * Escape, and backdrop all dismiss without touching it.
 */
export function ClipboardEditModal({
  text,
  enabled,
  onSetEnabled,
  onClose,
}: ClipboardEditModalProps) {
  const { t } = useTranslation();
  const { setting, setSetting } = useClipboardIndentSetting();
  const [initialDoc] = useState(() => trimLineEndWhitespace(text));

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by the dialog onKeyDown)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="clip-edit-backdrop" onClick={onClose}>
      <div
        className="clip-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("clipboardEdit.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Skip when the editor already consumed Escape (e.g. closing the open search panel), so the
          // first Escape only dismisses the panel and a second one closes the modal.
          if (e.key === "Escape" && !e.defaultPrevented) onClose();
          e.stopPropagation();
        }}
      >
        <h2 className="clip-edit-title">{t("clipboardEdit.title")}</h2>
        <p className="clip-edit-desc">{t("clipboardEdit.description")}</p>
        <div className="clip-edit-editor">
          <ClipboardCodeMirror initialDoc={initialDoc} setting={setting} />
        </div>
        <div className="clip-edit-indent">
          <span className="clip-edit-indent-label">
            {t("clipboardEdit.indent.label")}
          </span>
          <label>
            <input
              type="radio"
              name="clip-edit-indent-kind"
              checked={!setting.useTab}
              onChange={() => setSetting({ ...setting, useTab: false })}
            />
            <span>{t("clipboardEdit.indent.spaces")}</span>
          </label>
          <label>
            <input
              type="radio"
              name="clip-edit-indent-kind"
              checked={setting.useTab}
              onChange={() => setSetting({ ...setting, useTab: true })}
            />
            <span>{t("clipboardEdit.indent.tab")}</span>
          </label>
          {!setting.useTab && (
            <label className="clip-edit-indent-size">
              <span>{t("clipboardEdit.indent.width")}</span>
              <select
                value={setting.spaceCount}
                onChange={(e) =>
                  setSetting({
                    ...setting,
                    spaceCount: Number.parseInt(e.target.value, 10),
                  })
                }
              >
                {SPACE_COUNT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label className="clip-edit-never">
          <input
            type="checkbox"
            checked={!enabled}
            onChange={(e) => onSetEnabled(!e.target.checked)}
          />
          <span>{t("clipboardEdit.neverShow")}</span>
        </label>
        <div className="clip-edit-actions">
          <button type="button" className="clip-edit-close" onClick={onClose}>
            {t("clipboardEdit.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
