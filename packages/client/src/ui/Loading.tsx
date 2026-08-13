import { useTranslation } from "react-i18next";

export interface LoadingProps {
  /** Text shown beside the spinner (defaults to "Loading…"). */
  label?: string;
}

/**
 * The shared loading UI shown while fetching (spinner + text). Represents the
 * initial-fetch wait for VIEWER, SOURCE CONTROL, and others with the same look.
 * role=status so assistive technologies announce it.
 */
export function Loading({ label }: LoadingProps) {
  const { t } = useTranslation();
  const text = label ?? t("common.loading");
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <span className="loading-text">{text}</span>
    </div>
  );
}
