import { useTranslation } from "react-i18next";

/**
 * Error notification. Surfaced to the front rather than buried in the footer.
 * Non-modal (no overlay; does not block interaction behind it) and stays until
 * dismissed via the close button.
 */
export function ErrorDialog({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="error-dialog"
      role="alertdialog"
      aria-label={t("errorDialog.label")}
    >
      <div className="error-dialog-head">
        <span className="error-dialog-title" aria-hidden="true">
          {t("errorDialog.title")}
        </span>
        <button
          type="button"
          className="error-dialog-close"
          aria-label={t("common.close")}
          onClick={onDismiss}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            close
          </span>
        </button>
      </div>
      <p className="error-dialog-body">{message}</p>
    </div>
  );
}
