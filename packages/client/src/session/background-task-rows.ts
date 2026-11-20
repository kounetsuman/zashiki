import {
  type BackgroundTask,
  type BackgroundTaskStatus,
  backgroundTaskStatus,
  type StallRules,
} from "@zashiki/shared";

export interface BackgroundTaskRow {
  task: BackgroundTask;
  status: BackgroundTaskStatus;
}

export type BackgroundTaskFilter =
  | "stalled"
  | "running"
  | "ended"
  | "disconnected"
  | "all";

export const BACKGROUND_TASK_FILTERS: readonly BackgroundTaskFilter[] = [
  "stalled",
  "running",
  "ended",
  "disconnected",
  "all",
];

const STATUS_ORDER: Record<BackgroundTaskStatus["kind"], number> = {
  stalled: 0,
  running: 1,
  ended: 2,
  disconnected: 3,
};

/** Stalled first, then running, ended and disconnected; newest launch first within each. */
export function backgroundTaskRows(
  tasks: readonly BackgroundTask[],
  nowMs: number,
  rules: StallRules,
): BackgroundTaskRow[] {
  return tasks
    .map((task) => ({ task, status: backgroundTaskStatus(task, nowMs, rules) }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status.kind] - STATUS_ORDER[b.status.kind] ||
        (b.task.startedAt ?? 0) - (a.task.startedAt ?? 0),
    );
}

/** The statuses picked in the filter; picking none shows every row. */
export type StatusSelection = ReadonlySet<BackgroundTaskStatus["kind"]>;

export const DEFAULT_STATUS_SELECTION: StatusSelection = new Set([
  "stalled",
  "running",
]);

export function toggleFilter(
  selection: StatusSelection,
  filter: BackgroundTaskFilter,
): StatusSelection {
  if (filter === "all") return new Set();
  const next = new Set(selection);
  if (!next.delete(filter)) next.add(filter);
  return next;
}

export function isFilterSelected(
  selection: StatusSelection,
  filter: BackgroundTaskFilter,
): boolean {
  return filter === "all" ? selection.size === 0 : selection.has(filter);
}

export function filterRows(
  rows: readonly BackgroundTaskRow[],
  selection: StatusSelection,
): BackgroundTaskRow[] {
  return selection.size === 0
    ? [...rows]
    : rows.filter((r) => selection.has(r.status.kind));
}

export function countByFilter(
  rows: readonly BackgroundTaskRow[],
): Record<BackgroundTaskFilter, number> {
  const counts = { stalled: 0, running: 0, ended: 0, disconnected: 0, all: 0 };
  for (const r of rows) {
    counts[r.status.kind] += 1;
    counts.all += 1;
  }
  return counts;
}

export function stalledCockpitTerminalIds(
  rows: readonly BackgroundTaskRow[],
): ReadonlySet<string> {
  return new Set(
    rows
      .filter((r) => r.status.kind === "stalled")
      .map((r) => r.task.cockpitTerminalId),
  );
}

/** How far the live clock may run past the last successful poll before it waits for fresh tasks. */
export const LIVE_CLOCK_MAX_AHEAD_MS = 60_000;

/**
 * The clock the rows are judged at: the ticking wall clock, held back once the snapshot is stale so
 * a failing poll cannot turn running tasks stalled with no new output to go on.
 */
export function liveNowMs(tickMs: number, fetchedAt: number): number {
  return Math.min(tickMs, fetchedAt + LIVE_CLOCK_MAX_AHEAD_MS);
}

/** `h:mm:ss` from an hour up, `m:ss` below it. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A coarse age: seconds under a minute, minutes under an hour, then hours and minutes. */
export function formatAgo(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The first line of a command, cut to `max` characters. */
export function commandHead(command: string, max = 120): string {
  const first = command.split("\n")[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
