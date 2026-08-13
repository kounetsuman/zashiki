import { z } from "zod";

/**
 * In-app notifications (toasts + the NOTIFICATION panel).
 * Producer-independent sink data. The only current producer is "repos.conf org
 * layout changed -> restart required," but future update announcements (e.g.
 * local polling of GitHub Releases) will feed into the same shape. There is no
 * central delivery server.
 */
export const notificationLevelSchema = z.enum(["info", "warn", "error"]);

export type NotificationLevel = z.infer<typeof notificationLevelSchema>;

export const notificationSchema = z.object({
  /** Deduplication key for the same notification (the unique key for upsert). */
  id: z.string().min(1),
  level: notificationLevelSchema.default("info"),
  title: z.string(),
  /** Supplementary body text (null if none). */
  body: z.string().nullable().default(null),
  /** Creation time (epoch ms; used to determine display order; set by the server). */
  createdAt: z.number().int().nonnegative(),
  /** While true, the toast is never auto-dismissed (kept up until resolved, e.g. restart required). */
  sticky: z.boolean().default(false),
  /** Whether the user can manually dismiss it (false for sticky/system notifications). */
  dismissible: z.boolean().default(true),
  /**
   * Whether to show as a toast (defaults to true). Errors that have their own
   * surface (ErrorDialog) set this to false to avoid double display. It appears
   * in the NOTIFICATION panel regardless of the toast value.
   */
  toast: z.boolean().optional(),
});

export type Notification = z.infer<typeof notificationSchema>;

/** Fixed ID for the restart-required notification (a singleton; never stacked in duplicate). */
export const RESTART_REQUIRED_ID = "restart-required";

/**
 * The "please restart" notification shown when a change in repos.conf's org
 * layout (roots) is detected. sticky (stays until restart) and non-dismissible
 * (cannot be manually cleared).
 */
export function restartRequiredNotification(createdAt: number): Notification {
  return {
    id: RESTART_REQUIRED_ID,
    level: "warn",
    title: "設定ファイルが変更されました",
    body: "repos.conf の組織（org）構成が変わりました。反映するには zashiki を再起動してください。",
    createdAt,
    sticky: true,
    dismissible: false,
  };
}

/** Fixed ID for the PTY exhaustion-warning notification (a singleton; not stacked as it crosses the threshold back and forth). */
export const PTY_PRESSURE_ID = "pty-pressure";

/**
 * The notification shown when PTY usage escalates to the warn/block threshold.
 * dismissible (can be manually cleared), but since the id is fixed it is
 * replaced on each escalation rather than multiplying. level is error for
 * "block" and warn otherwise.
 */
export function ptyPressureNotification(
  used: number,
  max: number,
  level: "warn" | "block",
  createdAt: number,
): Notification {
  return {
    id: PTY_PRESSURE_ID,
    level: level === "block" ? "error" : "warn",
    title: "PTY（疑似端末）が逼迫しています",
    body: `使用 ≥${used} / 上限 ${max}。不要なタブ/セッションを閉じてください（枯渇するとセッション作成・復元が失敗します）。`,
    createdAt,
    sticky: false,
    dismissible: true,
  };
}

/**
 * A notification for stacking a server error (`{t:"error"}`) into NOTIFICATION.
 * Accumulates with a unique id per occurrence (the server assigns randomUUID).
 * Uses code as the title and message as the body.
 */
export function errorNotification(
  id: string,
  code: string,
  message: string,
  createdAt: number,
): Notification {
  return {
    id,
    level: "error",
    title: code,
    body: message,
    createdAt,
    sticky: false,
    dismissible: true,
    toast: false,
  };
}

/**
 * A notification for stacking Claude Code hooks' waiting/done into NOTIFICATION
 * (same wording as the toast). Accumulates with a unique id per occurrence.
 */
export function notifyNotification(
  id: string,
  kind: "waiting" | "done",
  windowTitle: string,
  createdAt: number,
): Notification {
  return {
    id,
    level: "info",
    title: `${kind === "waiting" ? "⏳ 応答待ち" : "✅ 完了"} ${windowTitle}`,
    body: null,
    createdAt,
    sticky: false,
    dismissible: true,
  };
}

/** Default list cap (a safeguard so unique-id notifications like error/notify don't accumulate without bound). */
export const NOTIFICATIONS_MAX = 100;

/**
 * Upserts, sorts newest-first, and evicts from oldest when exceeding max.
 * However, sticky or non-dismissible entries (things that should stay until
 * resolved, e.g. restart required) are never evicted. max<=0 means no limit.
 */
export function appendNotification(
  list: readonly Notification[],
  n: Notification,
  max: number,
): Notification[] {
  const upserted = upsertNotification(list, n);
  if (max <= 0 || upserted.length <= max) return upserted;
  const evictable = (x: Notification): boolean => !x.sticky && x.dismissible;
  const protectedCount = upserted.filter((x) => !evictable(x)).length;
  const allowedEvictable = Math.max(0, max - protectedCount);
  let keptEvictable = 0;
  return upserted.filter((x) => {
    if (!evictable(x)) return true;
    keptEvictable += 1;
    return keptEvictable <= allowedEvictable;
  });
}

/** Display order: newest-first (createdAt descending). Ties broken deterministically by id. */
function byNewest(a: Notification, b: Notification): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Replaces the same id, or appends if absent, then returns sorted newest-first (pure function). */
export function upsertNotification(
  list: readonly Notification[],
  n: Notification,
): Notification[] {
  return [...list.filter((x) => x.id !== n.id), n].sort(byNewest);
}

/**
 * Clearing by user action. Removes only dismissible notifications (sticky/system
 * notifications are kept).
 */
export function dismissNotification(
  list: readonly Notification[],
  id: string,
): Notification[] {
  return list.filter((x) => !(x.id === id && x.dismissible));
}

/** Server-driven withdrawal (removes by id regardless of dismissible; e.g. when roots revert). */
export function removeNotification(
  list: readonly Notification[],
  id: string,
): Notification[] {
  return list.filter((x) => x.id !== id);
}

/** Unread count (number of notifications not in seen). Used for the footer notification icon's badge. */
export function unreadCount(
  list: readonly Notification[],
  seenIds: readonly string[],
): number {
  const seen = new Set(seenIds);
  return list.reduce((acc, x) => (seen.has(x.id) ? acc : acc + 1), 0);
}

/**
 * Whether roots (the list of org root absolute paths) has changed since startup.
 * Compares order as well (reordering also affects org display order, and since
 * this is a startup snapshot it is not reflected immediately).
 */
export function rootsChanged(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}
