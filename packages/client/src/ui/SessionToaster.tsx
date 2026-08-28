import { notifyCategoryForKind } from "@zashiki/shared";
import { useTranslation } from "react-i18next";

import {
  SESSION_TOAST_MAX,
  type SessionToast,
  visibleSessionToasts,
} from "../state/session-toast-model.js";

export interface SessionToasterProps {
  toasts: readonly SessionToast[];
  /** Brings the tab to front and selects the toast's terminal. */
  onActivate: (cockpitTerminalId: string) => void;
  /** Dismisses the toast without selecting (× button). */
  onDismiss: (cockpitTerminalId: string) => void;
  /** Toasts shown at once (default {@link SESSION_TOAST_MAX}). */
  max?: number;
}

/**
 * Persistent, click-to-focus toasts for Claude Code waiting/done events, stacked in a screen corner.
 * A toast stays until its terminal is activated (click or selection) or dismissed by hand; extras
 * beyond {@link max} stay queued and surface as visible ones clear.
 */
export function SessionToaster({
  toasts,
  onActivate,
  onDismiss,
  max = SESSION_TOAST_MAX,
}: SessionToasterProps) {
  const { t } = useTranslation();
  const shown = visibleSessionToasts(toasts, max);
  if (shown.length === 0) return null;

  return (
    <div className="session-toaster" role="status" aria-live="polite">
      {shown.map((toast) => (
        <div
          key={toast.cockpitTerminalId}
          className={`toast session-toast session-toast-${toast.kind}`}
        >
          <button
            type="button"
            className="session-toast-main"
            title={t("notification.activate")}
            onClick={() => onActivate(toast.cockpitTerminalId)}
          >
            <span className="session-toast-status">
              {t(`notification.${notifyCategoryForKind(toast.kind) ?? "done"}`)}
            </span>
            {toast.org !== "" && (
              <span className="session-toast-org">{toast.org}</span>
            )}
            {toast.title !== null && toast.title !== "" && (
              <span className="session-toast-title">{toast.title}</span>
            )}
          </button>
          <button
            type="button"
            className="toast-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={() => onDismiss(toast.cockpitTerminalId)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
