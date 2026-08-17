import type { Notification, NotificationLevel } from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PanelEmpty } from "./PanelEmpty.js";
import { PanelHeader } from "./PanelHeader.js";
import { panelClass } from "./panels.js";

export interface NotificationPanelProps {
  notifications: readonly Notification[];
  /** Set of read ids (used to split into the unread/read tabs). */
  seenIds: readonly string[];
  /** Close button for a dismissible notification. Sends notification.dismiss to the server. */
  onDismiss(id: string): void;
  /** Marks a notification as read on double-click. */
  onMarkRead(id: string): void;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
}

type Tab = "unread" | "read";

/** Notification level -> Material Symbols icon name. */
const LEVEL_ICON: Record<NotificationLevel, string> = {
  info: "info",
  warn: "warning",
  error: "error",
};

function formatTime(createdAt: number): string {
  const d = new Date(createdAt);
  return d.toLocaleString();
}

/** Split into unread/read using the read set (preserves the upstream newest-first ordering). */
export function partitionBySeen(
  notifications: readonly Notification[],
  seenIds: readonly string[],
): { unread: Notification[]; read: Notification[] } {
  const seen = new Set(seenIds);
  const unread: Notification[] = [];
  const read: Notification[] = [];
  for (const n of notifications) (seen.has(n.id) ? read : unread).push(n);
  return { unread, read };
}

/**
 * List of in-app notifications (one panel of NAVIGATION). All notifications
 * (error / awaiting response / done / restart required / PTY pressure) accumulate
 * newest-first. Switch via the unread/read tabs; double-click an item to mark it
 * read, and dismissible notifications can be cleared with the close button. Read state is managed
 * in localStorage.
 */
export function NotificationPanel({
  notifications,
  seenIds,
  onDismiss,
  onMarkRead,
  inactive,
}: NotificationPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("unread");
  const { unread, read } = partitionBySeen(notifications, seenIds);
  const shown = tab === "unread" ? unread : read;
  return (
    <section
      className={panelClass("notification-panel", inactive)}
      data-panel="notification"
    >
      <PanelHeader title="NOTIFICATION" />
      <div className="notification-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "unread"}
          className={`notification-tab${tab === "unread" ? " is-active" : ""}`}
          onClick={() => setTab("unread")}
        >
          {t("notification.unread")}
          {unread.length > 0 ? ` (${unread.length})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "read"}
          className={`notification-tab${tab === "read" ? " is-active" : ""}`}
          onClick={() => setTab("read")}
        >
          {t("notification.read")}
          {read.length > 0 ? ` (${read.length})` : ""}
        </button>
      </div>
      <div className="notification-scroll">
        {shown.length === 0 ? (
          <PanelEmpty>
            {tab === "unread"
              ? t("notification.emptyUnread")
              : t("notification.emptyRead")}
          </PanelEmpty>
        ) : (
          <ul className="notification-list">
            {shown.map((n) => (
              <li
                key={n.id}
                className={`notification-item notification-${n.level}${
                  tab === "read" ? " notification-read" : ""
                }`}
                onDoubleClick={() => onMarkRead(n.id)}
                title={t("notification.markReadHint")}
              >
                <span
                  className="material-symbols-outlined notification-icon"
                  aria-hidden="true"
                >
                  {LEVEL_ICON[n.level]}
                </span>
                <div className="notification-main">
                  <div className="notification-title">{n.title}</div>
                  {n.body !== null && n.body !== "" && (
                    <div className="notification-body">{n.body}</div>
                  )}
                  <time className="notification-time">
                    {formatTime(n.createdAt)}
                  </time>
                </div>
                {n.dismissible && (
                  <button
                    type="button"
                    className="notification-dismiss"
                    aria-label={t("notification.dismiss")}
                    title={t("notification.dismiss")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismiss(n.id);
                    }}
                  >
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      close
                    </span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
