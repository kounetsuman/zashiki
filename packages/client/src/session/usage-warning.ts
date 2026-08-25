/**
 * Once-per-window gate for the near-limit warning. The dialog auto-opens and a notification fires the
 * first time the current session reaches the threshold within a reset window; dismissing it suppresses
 * the dialog until the window rolls over (a new `resetsAt`). Kept pure so the gating is unit-tested and
 * the hook only wires it to storage and the notifier.
 */

export interface UsageWarningRecord {
  /** The active window, keyed by its epoch-ms `resetsAt`; null before any is known. */
  window: number | null;
  notified: boolean;
  dismissed: boolean;
}

function freshFor(window: number | null): UsageWarningRecord {
  return { window, notified: false, dismissed: false };
}

export const EMPTY_USAGE_WARNING: UsageWarningRecord = freshFor(null);

export interface UsageWarningInput {
  active: boolean;
  window: number | null;
}

export interface UsageWarningStep {
  record: UsageWarningRecord;
  shouldOpen: boolean;
  shouldNotify: boolean;
}

/**
 * Folds the live (active, window) reading into the persisted record, yielding whether to open the
 * dialog and whether to notify. A warning needs a known window to key its once-per-window state on;
 * without one, or while inactive, it opens/notifies nothing. The record is keyed by window id, so a
 * transient data gap (window null) keeps the prior state — a genuine rollover to a new window re-arms
 * both anyway. Rising within a window notifies once and opens until dismissed.
 */
export function reduceUsageWarning(
  prev: UsageWarningRecord,
  { active, window }: UsageWarningInput,
): UsageWarningStep {
  if (window === null) {
    return { record: prev, shouldOpen: false, shouldNotify: false };
  }
  const base = window === prev.window ? prev : freshFor(window);
  if (!active) {
    return { record: base, shouldOpen: false, shouldNotify: false };
  }
  return {
    record: { window, notified: true, dismissed: base.dismissed },
    shouldOpen: !base.dismissed,
    shouldNotify: !base.notified,
  };
}

/** Marks the current window dismissed so the dialog stays closed until it rolls over. */
export function dismissUsageWarning(
  record: UsageWarningRecord,
): UsageWarningRecord {
  return { ...record, dismissed: true };
}
