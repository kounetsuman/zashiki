import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildIssueUrl } from "../api/crash.js";
import "./CrashReportModal.css";

export interface CrashReportModalProps {
  log: string;
  onClose(): void;
}

export function CrashReportModal({ log, onClose }: CrashReportModalProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = (): void => {
    void navigator.clipboard?.writeText(log).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by the window keydown above)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="crash-backdrop" onClick={onClose}>
      <div
        className="crash-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("crashReport.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="crash-head">
          <span className="crash-title">{t("crashReport.title")}</span>
          <button
            type="button"
            className="crash-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </div>
        <p className="crash-message">{t("crashReport.message")}</p>
        <pre className="crash-log">{log}</pre>
        <div className="crash-actions">
          <button type="button" className="crash-button" onClick={copy}>
            {t("crashReport.copy")}
          </button>
          <a
            className="crash-button crash-report"
            href={buildIssueUrl(log)}
            target="_blank"
            rel="noreferrer"
          >
            {t("crashReport.report")}
          </a>
          {copied && (
            <span className="crash-copied" role="status" aria-live="polite">
              {t("crashReport.copied")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
