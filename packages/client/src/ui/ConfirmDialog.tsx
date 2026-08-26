import { useTranslation } from "react-i18next";
import { Modal } from "./Modal.js";
import "./ConfirmDialog.css";

export interface ConfirmDialogProps {
  title: string;
  message: string;
  /** Label for the confirming (destructive) action. */
  confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
}

/** A small yes/no modal for a destructive action (currently the explorer's move-to-trash). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      title={title}
      closeLabel={t("common.cancel")}
      onClose={onCancel}
      className="confirm-dialog"
    >
      <p className="confirm-dialog-message">{message}</p>
      <div className="confirm-dialog-actions">
        <button
          type="button"
          className="confirm-dialog-cancel"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="confirm-dialog-confirm"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
