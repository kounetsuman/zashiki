import type {
  ClaudeInstall,
  RuntimeUpdateStatusMessage,
} from "@zashiki/shared";
import { useTranslation } from "react-i18next";

export interface RuntimeInfoViewProps {
  /** Detected Claude Code CLI installations (from runtime.info), active first. */
  installs: ClaudeInstall[];
  /** Latest runtime.update progress, or null before any update was triggered. */
  updateStatus: Omit<RuntimeUpdateStatusMessage, "t"> | null;
  /** Rescan the machine (sends runtime.query). */
  onRefresh(): void;
  /** Update the active native install (sends runtime.update). */
  onUpdate(): void;
}

/**
 * Read-only list of the Claude Code CLI installations on this machine (the SETTINGS "Claude Code"
 * tab). Marks the active install and offers an in-app Update only for a native active install; other
 * methods show the command to run by hand.
 */
export function RuntimeInfoView({
  installs,
  updateStatus,
  onRefresh,
  onUpdate,
}: RuntimeInfoViewProps) {
  const { t } = useTranslation();
  const active = installs.find((install) => install.isActive);
  const updating = updateStatus?.state === "running";

  return (
    <div className="runtime-info">
      <div className="settings-field">
        <span className="settings-label">{t("runtime.section")}</span>
        <span className="settings-hint">{t("runtime.sectionHint")}</span>
      </div>
      {installs.length === 0 ? (
        <p className="settings-hint">{t("runtime.empty")}</p>
      ) : (
        <ul className="runtime-install-list">
          {installs.map((install) => (
            <li
              key={install.path}
              className={`runtime-install${install.isActive ? " is-active" : ""}`}
            >
              <div className="runtime-install-head">
                <span className="runtime-method">
                  {t(`runtime.method.${install.method}`)}
                </span>
                <span
                  className={`runtime-badge ${install.isActive ? "runtime-badge-active" : "runtime-badge-leftover"}`}
                >
                  {install.isActive
                    ? t("runtime.active")
                    : t("runtime.leftover")}
                </span>
                <span className="runtime-version">
                  {install.version ?? t("runtime.versionUnknown")}
                </span>
              </div>
              <code className="runtime-path">{install.path}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-field">
        <div className="runtime-actions">
          <button type="button" className="settings-save" onClick={onRefresh}>
            {t("runtime.refresh")}
          </button>
          {active?.method === "native" && (
            <button
              type="button"
              className="settings-save"
              disabled={updating}
              onClick={onUpdate}
            >
              {t("runtime.update")}
            </button>
          )}
        </div>
        {active !== undefined && active.method !== "native" && (
          <span className="settings-hint">
            {t(
              `runtime.manualUpdate.${active.method === "volta" ? "npm_global" : active.method}`,
            )}
          </span>
        )}
        {updateStatus !== null && (
          <span className="settings-update-status" aria-live="polite">
            {updateStatus.state === "running" && t("runtime.updateRunning")}
            {updateStatus.state === "done" && t("runtime.updateDone")}
            {updateStatus.state === "unsupported" &&
              t("runtime.updateUnsupported")}
            {updateStatus.state === "failed" &&
              t("runtime.updateFailed", { detail: updateStatus.detail ?? "" })}
          </span>
        )}
      </div>
    </div>
  );
}
