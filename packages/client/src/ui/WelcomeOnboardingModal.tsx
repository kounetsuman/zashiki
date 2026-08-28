import { useTranslation } from "react-i18next";

import "./onboarding-card.css";

export interface WelcomeOnboardingModalProps {
  /** Continue into the Claude Code integration setup step. */
  onStart(): void;
  /** Leave onboarding without continuing (remembered so it won't reappear). */
  onSkip(): void;
}

/**
 * First step of the first-run onboarding: a one-screen welcome that hands off to the Claude Code
 * integration setup (FirstRunSetupWizard) so the two read as a single flow. Shares the card styling
 * with that step; the flow is dismissed only through its buttons, not by a backdrop click or Escape.
 */
export function WelcomeOnboardingModal({
  onStart,
  onSkip,
}: WelcomeOnboardingModalProps) {
  const { t } = useTranslation();

  return (
    <div className="onboarding-backdrop">
      <div
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("onboarding.title")}
      >
        <h2 className="onboarding-title">{t("onboarding.title")}</h2>
        <p className="onboarding-body">{t("onboarding.intro")}</p>
        <p className="onboarding-note">{t("onboarding.note")}</p>
        <div className="onboarding-actions">
          <button type="button" className="onboarding-button" onClick={onSkip}>
            {t("onboarding.skip")}
          </button>
          <button
            type="button"
            className="onboarding-button onboarding-button-primary"
            onClick={onStart}
          >
            {t("onboarding.getStarted")}
          </button>
        </div>
      </div>
    </div>
  );
}
