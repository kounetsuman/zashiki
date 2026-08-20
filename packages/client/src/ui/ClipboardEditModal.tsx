import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
 * A scratchpad for the copied selection so a hard-wrapped one-liner can be rejoined by hand before
 * pasting. OK writes the edited text back to the clipboard; Escape / backdrop dismiss without writing.
 */
export function ClipboardEditModal({
  text,
  enabled,
  onSetEnabled,
  onClose,
}: ClipboardEditModalProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => textareaRef.current?.focus(), []);

  const confirm = (): void => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    onClose();
  };

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
        <div className="clip-edit-head">
          <h2 className="clip-edit-title">{t("clipboardEdit.title")}</h2>
          <span
            className="clip-edit-help material-symbols-outlined"
            role="img"
            aria-label={t("clipboardEdit.help")}
            title={t("clipboardEdit.help")}
          >
            help
          </span>
        </div>
        <textarea
          ref={textareaRef}
          className="clip-edit-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
        />
        <label className="clip-edit-never">
          <input
            type="checkbox"
            checked={!enabled}
            onChange={(e) => onSetEnabled(!e.target.checked)}
          />
          <span>{t("clipboardEdit.neverShow")}</span>
        </label>
        <div className="clip-edit-actions">
          <button type="button" className="clip-edit-ok" onClick={confirm}>
            {t("clipboardEdit.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
