import { useTranslation } from "react-i18next";

import { useModalEscape } from "./useModalEscape.js";
import "./UsageLimitWarningDialog.css";

export interface UsageLimitWarningDialogProps {
  /** Headroom left before the current session locks out, as a whole percent. */
  remainingPercent: number;
  /** Absolute local time the session unlocks at, already formatted for the active locale. */
  unlockTime: string;
  onClose(): void;
}

/**
 * Near-limit warning for the current session, auto-shown once per reset window. It states how much
 * headroom is left and the wall-clock time the window unlocks; dismissing it suppresses it until the
 * window rolls over (gated by {@link ../session/usage-warning}).
 */
export function UsageLimitWarningDialog({
  remainingPercent,
  unlockTime,
  onClose,
}: UsageLimitWarningDialogProps) {
  const { t } = useTranslation();
  useModalEscape(onClose);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by the window keydown above)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="usage-warning-backdrop" onClick={onClose}>
      <div
        className="usage-warning-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={t("usageWarning.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 className="usage-warning-title">
          <span
            className="material-symbols-outlined usage-warning-icon"
            aria-hidden="true"
          >
            warning
          </span>
          {t("usageWarning.title")}
        </h2>
        <p className="usage-warning-body">
          {t("usageWarning.body", { percent: remainingPercent })}
        </p>
        <ul className="usage-warning-facts">
          <li>{t("usageWarning.unlockAt", { time: unlockTime })}</li>
        </ul>
        <div className="usage-warning-actions">
          <button
            type="button"
            className="usage-warning-close"
            onClick={onClose}
          >
            {t("usageWarning.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
