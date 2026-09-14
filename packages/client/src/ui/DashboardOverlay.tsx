import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { DASHBOARD_SANDBOX, type DashboardFrame } from "../lib/dashboard.js";
import { Modal } from "./Modal.js";
import "./DashboardOverlay.css";

export interface DashboardOverlayProps {
  frame: DashboardFrame;
  /** Changes per showing; remounts the frame so a trigger reloads a page that is already up. */
  showNonce?: number;
  onClose(): void;
}

/**
 * The configured dashboard page, drawn over the cockpit until dismissed. The page is framed rather
 * than opened in its own window so Escape and the backdrop stay in the app's hands; focus is left on
 * the dialog so Escape works before the user reaches into the page. This is the one overlay that can
 * appear unasked, so whatever held focus when it opened gets it back when it closes.
 */
export function DashboardOverlay({
  frame,
  showNonce,
  onClose,
}: DashboardOverlayProps) {
  const { t } = useTranslation();
  const title = t("dashboard.title");

  // Captured while rendering: Modal's own effect moves focus into the dialog before any effect here
  // could read it. Restored after the commit that removes the dialog, or the browser would reset
  // focus to the body instead.
  const [interrupted] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      queueMicrotask(() => {
        if (interrupted instanceof HTMLElement && interrupted.isConnected)
          interrupted.focus();
      });
    },
    [interrupted],
  );

  return (
    <Modal
      title={title}
      closeLabel={t("common.close")}
      onClose={onClose}
      className="dashboard-modal"
    >
      {frame.kind === "error" ? (
        <div className="dashboard-error" role="alert">
          <p>{t("dashboard.readFailed")}</p>
          <pre className="dashboard-error-detail">{frame.detail}</pre>
        </div>
      ) : frame.kind === "remote" ? (
        <iframe
          key={showNonce}
          className="dashboard-frame"
          title={title}
          sandbox={DASHBOARD_SANDBOX}
          src={frame.url}
        />
      ) : (
        <iframe
          key={showNonce}
          className="dashboard-frame"
          title={title}
          sandbox={DASHBOARD_SANDBOX}
          srcDoc={frame.html}
        />
      )}
    </Modal>
  );
}
