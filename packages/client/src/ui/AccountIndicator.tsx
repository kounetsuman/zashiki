import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AccountRefreshConfirmModal } from "./AccountRefreshConfirmModal.js";
import "./AccountIndicator.css";

export interface AccountIndicatorProps {
  /** Signed-in account email, or null when not signed in / status unread. */
  email: string | null;
  /** Number of running cockpit terminals, which are restarted to adopt a switched account. */
  runningCount: number;
  /** Re-read the account; when `restartSessions` is true the server also restarts the running ones. */
  onRefresh(restartSessions: boolean): void;
}

/**
 * Top-right signed-in Claude account with a refresh control. Refreshing re-reads the account; when
 * cockpit terminals are running it first confirms restarting them so a switched account applies there
 * too. With none running it refreshes straight away.
 */
export function AccountIndicator({
  email,
  runningCount,
  onRefresh,
}: AccountIndicatorProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  function onRefreshClick(): void {
    if (runningCount > 0) {
      setConfirming(true);
    } else {
      onRefresh(false);
    }
  }

  return (
    <div className="account-indicator">
      <span className="account-indicator-email">
        {email ?? t("account.notSignedIn")}
      </span>
      <button
        type="button"
        className="account-indicator-refresh"
        title={t("account.refreshTooltip")}
        aria-label={t("common.refresh")}
        onClick={onRefreshClick}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          refresh
        </span>
      </button>
      {confirming && (
        <AccountRefreshConfirmModal
          runningCount={runningCount}
          onConfirm={() => {
            setConfirming(false);
            onRefresh(true);
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
