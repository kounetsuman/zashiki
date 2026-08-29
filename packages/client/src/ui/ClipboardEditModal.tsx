import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  indentSelection,
  MAX_SPACE_COUNT,
  MIN_SPACE_COUNT,
  outdentSelection,
} from "../lib/clipboard-edit-indent.js";
import { trimLineEndWhitespace } from "../lib/clipboard-edit-modal.js";
import { useClipboardIndentSetting } from "./useClipboardIndentSetting.js";
import "./ClipboardEditModal.css";

const SPACE_COUNT_OPTIONS = Array.from(
  { length: MAX_SPACE_COUNT - MIN_SPACE_COUNT + 1 },
  (_, i) => MIN_SPACE_COUNT + i,
);

export interface ClipboardEditModalProps {
  /** The just-copied selection, prefilled into the editable textarea. */
  text: string;
  /** Current setting; the in-modal switch reflects and flips it (checked = "don't show again"). */
  enabled: boolean;
  onSetEnabled(enabled: boolean): void;
  onClose(): void;
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
  const [value, setValue] = useState(() => trimLineEndWhitespace(text));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const pendingSelection = useRef<[number, number] | null>(null);

  useEffect(() => textareaRef.current?.focus(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the re-run trigger — restore the caret once the controlled textarea has rendered the re-indented text
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    if (pending && textareaRef.current) {
      textareaRef.current.setSelectionRange(pending[0], pending[1]);
      pendingSelection.current = null;
    }
  }, [value]);

  const handleIndentKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const { selectionStart, selectionEnd } = e.currentTarget;
    const reindent = e.shiftKey ? outdentSelection : indentSelection;
    const next = reindent(
      { value, start: selectionStart, end: selectionEnd },
      setting,
    );
    pendingSelection.current = [next.start, next.end];
    setValue(next.value);
  };

  const lineNumbers = value
    .split("\n")
    .map((_, i) => i + 1)
    .join("\n");

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
          if (e.key === "Escape") onClose();
          e.stopPropagation();
        }}
      >
        <h2 className="clip-edit-title">{t("clipboardEdit.title")}</h2>
        <p className="clip-edit-desc">{t("clipboardEdit.description")}</p>
        <div className="clip-edit-editor">
          <div className="clip-edit-gutter" ref={gutterRef} aria-hidden="true">
            {lineNumbers}
          </div>
          <textarea
            ref={textareaRef}
            className="clip-edit-textarea"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleIndentKey}
            onScroll={(e) => {
              if (gutterRef.current)
                gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            spellCheck={false}
            wrap="off"
          />
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
