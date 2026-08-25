import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { trimLineEndWhitespace } from "../lib/clipboard-edit-modal.js";
import "./ClipboardEditModal.css";

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
  const [value, setValue] = useState(() => trimLineEndWhitespace(text));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => textareaRef.current?.focus(), []);

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
            onScroll={(e) => {
              if (gutterRef.current)
                gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            spellCheck={false}
            wrap="off"
          />
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
