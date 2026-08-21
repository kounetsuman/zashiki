import { useTranslation } from "react-i18next";

export interface UpdateBannerProps {
  version: string | null;
  /** True while an update is in progress (spinner + disabled). */
  updating: boolean;
  /** Start the self-update (brew upgrade + relaunch on the desktop app, else open the releases page). */
  onUpdate(): void;
}

/**
 * Header button offering the available update; renders only when one exists. Clicking triggers the
 * server-side self-update and, while it runs, shows a spinner and disables itself.
 */
export function UpdateBanner({
  version,
  updating,
  onUpdate,
}: UpdateBannerProps) {
  const { t } = useTranslation();
  if (version === null) return null;
  return (
    <div className="update-banner">
      <button
        type="button"
        className="update-banner-button"
        disabled={updating}
        title={t("update.tooltip", { version })}
        onClick={onUpdate}
      >
        <span
          className={`material-symbols-outlined${updating ? " update-spin" : ""}`}
          aria-hidden="true"
        >
          {updating ? "progress_activity" : "upgrade"}
        </span>
        <span>{updating ? t("update.updating") : t("update.button")}</span>
      </button>
    </div>
  );
}
