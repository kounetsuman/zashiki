import { useEffect } from "react";
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
 * with that step; Escape and a backdrop click skip the flow.
 */
export function WelcomeOnboardingModal({
  onStart,
  onSkip,
}: WelcomeOnboardingModalProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by the window keydown above)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="onboarding-backdrop" onClick={onSkip}>
      <div
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("onboarding.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
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
