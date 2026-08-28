import type { NotifyKind } from "../lib/notify-sound.js";

/**
 * A transient toast for a Claude Code waiting/done event, driven by the notify push (not the
 * NOTIFICATION list). One toast per Cockpit Terminal — a newer event for the same terminal
 * replaces the old one with the latest kind. Persists until the terminal is activated or dismissed.
 */
export interface SessionToast {
  /** cockpitTerminalId; also the coalescing key. */
  cockpitTerminalId: string;
  kind: NotifyKind;
  /** org display label (alias when set, otherwise the org identity). */
  org: string;
  /** session summary title (first utterance), or null when unknown. */
  title: string | null;
}

/** Toasts shown at once; extras stay queued and surface as visible ones are dismissed. */
export const SESSION_TOAST_MAX = 5;

/** Upsert by cockpitTerminalId, moving the (possibly updated) toast to the front. Newest first. */
export function upsertSessionToast(
  list: readonly SessionToast[],
  toast: SessionToast,
): SessionToast[] {
  return [
    toast,
    ...list.filter((t) => t.cockpitTerminalId !== toast.cockpitTerminalId),
  ];
}

/** Removes the toast for a terminal (on activation or dismissal); a no-op when absent. */
export function removeSessionToast(
  list: readonly SessionToast[],
  cockpitTerminalId: string,
): SessionToast[] {
  return list.filter((t) => t.cockpitTerminalId !== cockpitTerminalId);
}

/** Drops toasts whose terminal is no longer present (closed). */
export function pruneClosedSessionToasts(
  list: readonly SessionToast[],
  liveIds: ReadonlySet<string>,
): SessionToast[] {
  const next = list.filter((t) => liveIds.has(t.cockpitTerminalId));
  return next.length === list.length ? (list as SessionToast[]) : next;
}

/** The capped, newest-first slice currently shown. */
export function visibleSessionToasts(
  list: readonly SessionToast[],
  max: number = SESSION_TOAST_MAX,
): SessionToast[] {
  return list.slice(0, max);
}
