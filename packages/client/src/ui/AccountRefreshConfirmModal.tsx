import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import "./AccountUsageModal.css";

export interface AccountRefreshConfirmModalProps {
  /** Number of running cockpit terminals that will be restarted to adopt the switched account. */
  runningCount: number;
  onConfirm(): void;
  onClose(): void;
}

/**
 * Confirms restarting the running cockpit terminals so a switched Claude account reaches them. Only
 * shown when at least one is running (a refresh with none simply re-reads the name).
 */
export function AccountRefreshConfirmModal({
  runningCount,
  onConfirm,
  onClose,
}: AccountRefreshConfirmModalProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by the window keydown above)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="account-usage-backdrop" onClick={onClose}>
      <div
        className="account-usage-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("account.confirmTitle")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 className="account-usage-modal-title">
          {t("account.confirmTitle")}
        </h2>
        <p className="account-usage-modal-body">
          {t("account.confirmBody", { count: runningCount })}
        </p>
        <div className="account-usage-modal-actions">
          <button
            type="button"
            className="account-usage-modal-cancel"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="account-usage-modal-enable"
            onClick={onConfirm}
          >
            {t("account.confirmApply")}
          </button>
        </div>
      </div>
    </div>
  );
}
