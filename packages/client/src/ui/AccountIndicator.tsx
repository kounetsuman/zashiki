import { useEffect, useRef, useState } from "react";
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
  /** Start the interactive browser login (switches the account when a different one is chosen). */
  onLogin(): void;
  /** Sign the current account out. */
  onLogout(): void;
}

/**
 * Top-right signed-in Claude account as a menu button. The menu reloads the account (confirming a
 * session restart first when cockpit terminals are running, so a switched account applies there too),
 * signs in with a different account, or signs out.
 */
export function AccountIndicator({
  email,
  runningCount,
  onRefresh,
  onLogin,
  onLogout,
}: AccountIndicatorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent): void {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function reload(): void {
    setOpen(false);
    if (runningCount > 0) setConfirming(true);
    else onRefresh(false);
  }

  return (
    <div className="account-indicator" ref={rootRef}>
      <button
        type="button"
        className="account-indicator-email"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("account.menuTooltip")}
        onClick={() => setOpen((v) => !v)}
      >
        {email ?? t("account.notSignedIn")}
      </button>
      {open && (
        <div className="account-indicator-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="account-indicator-item"
            title={t("account.refreshTooltip")}
            onClick={reload}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              refresh
            </span>
            {t("account.reload")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="account-indicator-item"
            onClick={() => {
              setOpen(false);
              onLogin();
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              swap_horiz
            </span>
            {t("account.signInOther")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="account-indicator-item"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              logout
            </span>
            {t("account.signOut")}
          </button>
        </div>
      )}
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
