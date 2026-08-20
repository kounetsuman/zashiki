import { useTranslation } from "react-i18next";

export interface LimitIndicatorProps {
  /** The number of cockpit terminals that have hit the usage limit. Hidden if 0 or less. */
  count: number;
}

/**
 * A subtle warning in the footer status-bar for hitting the usage limit.
 * Renders nothing if count is 0 or less. The full text is held in the title.
 */
export function LimitIndicator({ count }: LimitIndicatorProps) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <span
      className="limit-indicator"
      role="alert"
      aria-live="polite"
      title={t("limit.title", { count })}
    >
      <span
        className="material-symbols-outlined limit-indicator-icon"
        aria-hidden="true"
      >
        error
      </span>
      <span className="limit-indicator-text">{t("limit.text", { count })}</span>
    </span>
  );
}
