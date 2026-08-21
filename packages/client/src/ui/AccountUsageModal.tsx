import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import "./AccountUsageModal.css";

export interface AccountUsageModalProps {
  /** Whether the bridge is currently opted in (drives the enable/close affordances). */
  enabled: boolean;
  /** Number of already-running cockpit terminals, which only reflect usage after a resume. */
  runningCount: number;
  /** Persist the opt-in (config.setAccountUsage). */
  onEnable(): void;
  onClose(): void;
}

/**
 * Opt-in dialog reached from the footer gauge while account usage is off. One click enables the bridge;
 * it also notes that already-running cockpit terminals reflect usage only after a resume.
 */
export function AccountUsageModal({
  enabled,
  runningCount,
  onEnable,
  onClose,
}: AccountUsageModalProps) {
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
        aria-label={t("accountUsage.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 className="account-usage-modal-title">{t("accountUsage.title")}</h2>
        <p className="account-usage-modal-body">{t("accountUsage.body")}</p>
        <p className="account-usage-modal-note">
          {t("accountUsage.subscriptionNote")}
        </p>
        {enabled && runningCount > 0 && (
          <p className="account-usage-modal-resume" role="status">
            {t("accountUsage.resumeNote", { count: runningCount })}
          </p>
        )}
        <div className="account-usage-modal-actions">
          <button
            type="button"
            className="account-usage-modal-cancel"
            onClick={onClose}
          >
            {t("accountUsage.close")}
          </button>
          {!enabled && (
            <button
              type="button"
              className="account-usage-modal-enable"
              onClick={onEnable}
            >
              {t("accountUsage.enable")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
