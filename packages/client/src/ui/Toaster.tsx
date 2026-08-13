import type { Notification, NotificationLevel } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ToasterProps {
  notifications: readonly Notification[];
  /** ms until a non-sticky toast auto-dismisses (default 6000). */
  autoHideMs?: number;
}

const LEVEL_ICON: Record<NotificationLevel, string> = {
  info: "info",
  warn: "warning",
  error: "error",
};

/**
 * Notifications that should currently be shown as toasts (pure function, for testing). sticky ones
 * are always shown (e.g. restart-required; kept up until resolved). Non-sticky ones only if not in
 * hidden (auto-dismissed or manually closed).
 */
export function visibleToasts(
  notifications: readonly Notification[],
  hidden: ReadonlySet<string>,
): Notification[] {
  return notifications.filter(
    (n) => n.toast !== false && (n.sticky || !hidden.has(n.id)),
  );
}

/**
 * Toast display stacked in a screen corner. Non-sticky toasts auto-dismiss after a while but
 * remain in the NOTIFICATION panel list (toast visibility != presence in the list). sticky ones
 * (restart-required) stay until the server withdraws them (= restart). Closing a toast does not remove it from the list.
 */
export function Toaster({ notifications, autoHideMs = 6000 }: ToasterProps) {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const live = new Set(notifications.map((n) => n.id));
    // Remove notifications that dropped from the list from hidden and the timers (so they can show again if they reappear).
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    setHidden((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // Set an auto-dismiss timer for non-sticky, not-yet-dismissed ones (non-toast ones are excluded).
    for (const n of notifications) {
      if (n.toast === false) continue;
      if (n.sticky) continue;
      if (timers.current.has(n.id)) continue;
      const timer = setTimeout(() => {
        timers.current.delete(n.id);
        setHidden((prev) => new Set(prev).add(n.id));
      }, autoHideMs);
      timers.current.set(n.id, timer);
    }
  }, [notifications, autoHideMs]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const close = (id: string): void =>
    setHidden((prev) => new Set(prev).add(id));

  const shown = visibleToasts(notifications, hidden);
  if (shown.length === 0) return null;

  return (
    <div className="toaster" role="status" aria-live="polite">
      {shown.map((n) => (
        <div key={n.id} className={`toast toast-${n.level}`}>
          <span
            className="material-symbols-outlined toast-icon"
            aria-hidden="true"
          >
            {LEVEL_ICON[n.level]}
          </span>
          <div className="toast-main">
            <div className="toast-title">{n.title}</div>
            {n.body !== null && n.body !== "" && (
              <div className="toast-body">{n.body}</div>
            )}
          </div>
          {!n.sticky && (
            <button
              type="button"
              className="toast-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => close(n.id)}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                close
              </span>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
