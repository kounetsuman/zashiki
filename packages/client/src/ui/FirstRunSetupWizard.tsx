import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import "./onboarding-card.css";

export interface FirstRunSetupWizardProps {
  /** Whether a non-zashiki statusLine is present (registering will wrap it to preserve it). */
  statusLineConflict: boolean;
  /** Install the integration (hooks.register) and dismiss. */
  onEnable(): void;
  /** Dismiss without installing (remembered so it won't reappear). */
  onDismiss(): void;
}

/**
 * First-run dialog offered while zashiki's Claude Code integration is absent. One click installs the
 * hooks + statusLine so notifications and the usage footer work; dismissing is remembered per machine.
 */
export function FirstRunSetupWizard({
  statusLineConflict,
  onEnable,
  onDismiss,
}: FirstRunSetupWizardProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by the window keydown above)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="onboarding-backdrop" onClick={onDismiss}>
      <div
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("firstRun.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 className="onboarding-title">{t("firstRun.title")}</h2>
        <p className="onboarding-body">{t("firstRun.body")}</p>
        <p className="onboarding-note">{t("firstRun.preserveNote")}</p>
        {statusLineConflict && (
          <p className="onboarding-conflict" role="status">
            {t("firstRun.statusLineConflict")}
          </p>
        )}
        <div className="onboarding-actions">
          <button
            type="button"
            className="onboarding-button"
            onClick={onDismiss}
          >
            {t("firstRun.notNow")}
          </button>
          <button
            type="button"
            className="onboarding-button onboarding-button-primary"
            onClick={onEnable}
          >
            {t("firstRun.enable")}
          </button>
        </div>
      </div>
    </div>
  );
}
