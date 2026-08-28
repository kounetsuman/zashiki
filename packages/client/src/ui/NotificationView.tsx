import type { Notification, NotificationLevel } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ViewEmpty } from "./ViewEmpty.js";
import { ViewHeader } from "./ViewHeader.js";

export interface NotificationViewProps {
  notifications: readonly Notification[];
  /** Read ids; splits the list into the unread/read tabs. */
  seenIds: readonly string[];
  /** Marks notifications as read (mark-read button, double-click, and bulk). */
  onMarkRead(ids: readonly string[]): void;
  /** Deletes the given notifications (confirmed read-tab delete, single or bulk). */
  onDelete(ids: readonly string[]): void;
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

/** Header checkbox reflecting all/none/partial selection (indeterminate has no React prop). */
function SelectAllCheckbox({
  checked,
  indeterminate,
  label,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  label: string;
  onToggle(): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="notification-select-all"
      aria-label={label}
      title={label}
      checked={checked}
      onChange={onToggle}
    />
  );
}

/**
 * List of in-app notifications (one view of NAVIGATION). All notifications
 * (error / awaiting response / done / restart required / PTY pressure) accumulate
 * newest-first. Unread items are marked read (button, double-click, or bulk) but never
 * deleted; only read items can be deleted, individually or in bulk, and only after
 * a confirm dialog. Each tab offers checkboxes plus select-all for its bulk action.
 * Non-dismissible ones (restart required) can be marked read but not deleted.
 * Read state is managed in localStorage.
 */
export function NotificationView({
  notifications,
  seenIds,
  onMarkRead,
  onDelete,
}: NotificationViewProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("unread");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const { unread, read } = partitionBySeen(notifications, seenIds);
  const shown = tab === "unread" ? unread : read;

  const switchTab = (next: Tab): void => {
    setTab(next);
    setSelected(new Set());
  };

  const toggleSelected = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const isSelectable = (n: Notification): boolean =>
    tab === "unread" ? true : n.dismissible;
  const selectable = shown.filter(isSelectable);
  const selectedIds = selectable
    .filter((n) => selected.has(n.id))
    .map((n) => n.id);
  const allSelected =
    selectable.length > 0 && selectedIds.length === selectable.length;
  const someSelected = selectedIds.length > 0;

  const toggleSelectAll = (): void =>
    setSelected(allSelected ? new Set() : new Set(selectable.map((n) => n.id)));

  const markReadSelected = (): void => {
    onMarkRead(selectedIds);
    setSelected(new Set());
  };

  const bulkAction =
    tab === "unread"
      ? {
          className: "notification-bulk-read",
          label: t("notification.markReadSelected"),
          icon: "mark_email_read",
          onClick: markReadSelected,
        }
      : {
          className: "notification-bulk-delete",
          label: t("notification.deleteSelected"),
          icon: "delete",
          onClick: () => setPendingDelete(selectedIds),
        };

  const confirmDelete = (): void => {
    if (pendingDelete !== null) onDelete(pendingDelete);
    setSelected(new Set());
    setPendingDelete(null);
  };

  return (
    <section className="notification-view" data-view="notification">
      <ViewHeader title="NOTIFICATION" />
      <div className="notification-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "unread"}
          className={`notification-tab${tab === "unread" ? " is-active" : ""}`}
          onClick={() => switchTab("unread")}
        >
          {t("notification.unread")}
          {unread.length > 0 ? ` (${unread.length})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "read"}
          className={`notification-tab${tab === "read" ? " is-active" : ""}`}
          onClick={() => switchTab("read")}
        >
          {t("notification.read")}
          {read.length > 0 ? ` (${read.length})` : ""}
        </button>
        {selectable.length > 0 && (
          <div className="notification-tab-actions">
            <SelectAllCheckbox
              checked={allSelected}
              indeterminate={someSelected && !allSelected}
              label={t("notification.selectAll")}
              onToggle={toggleSelectAll}
            />
            {someSelected && (
              <button
                type="button"
                className={bulkAction.className}
                aria-label={bulkAction.label}
                title={bulkAction.label}
                onClick={bulkAction.onClick}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {bulkAction.icon}
                </span>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="notification-scroll">
        {shown.length === 0 ? (
          <ViewEmpty>
            {tab === "unread"
              ? t("notification.emptyUnread")
              : t("notification.emptyRead")}
          </ViewEmpty>
        ) : (
          <ul className="notification-list">
            {shown.map((n) => (
              <li
                key={n.id}
                className={`notification-item notification-${n.level}${
                  tab === "read" ? " notification-read" : ""
                }`}
                onDoubleClick={() => tab === "unread" && onMarkRead([n.id])}
                title={
                  tab === "unread" ? t("notification.markReadHint") : undefined
                }
              >
                {isSelectable(n) && (
                  <input
                    type="checkbox"
                    className="notification-select"
                    aria-label={
                      tab === "unread"
                        ? t("notification.selectMarkRead")
                        : t("notification.select")
                    }
                    checked={selected.has(n.id)}
                    onChange={() => toggleSelected(n.id)}
                  />
                )}
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
                {tab === "unread" ? (
                  <button
                    type="button"
                    className="notification-mark-read"
                    aria-label={t("notification.markRead")}
                    title={t("notification.markRead")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMarkRead([n.id]);
                    }}
                  >
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      mark_email_read
                    </span>
                  </button>
                ) : (
                  n.dismissible && (
                    <button
                      type="button"
                      className="notification-delete"
                      aria-label={t("notification.delete")}
                      title={t("notification.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete([n.id]);
                      }}
                    >
                      <span
                        className="material-symbols-outlined"
                        aria-hidden="true"
                      >
                        close
                      </span>
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {pendingDelete !== null && (
        <div
          className="notification-confirm-overlay"
          role="dialog"
          aria-modal="true"
        >
          <div className="notification-confirm">
            <p className="notification-confirm-message">
              {t("notification.confirmDelete", { count: pendingDelete.length })}
            </p>
            <div className="notification-confirm-actions">
              <button
                type="button"
                className="notification-confirm-cancel"
                onClick={() => setPendingDelete(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="notification-confirm-delete"
                onClick={confirmDelete}
              >
                {t("notification.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
