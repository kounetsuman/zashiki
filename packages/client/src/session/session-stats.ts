import type { SessionEvent, SessionEventDeniedBy } from "@zashiki/shared";

import { fmtDuration } from "./status-footer.js";

export type StatsGroup = "files" | "commands" | "external" | "denials";

export type TimelineFilter = "all" | StatsGroup;

export const TIMELINE_FILTERS: readonly TimelineFilter[] = [
  "all",
  "files",
  "commands",
  "external",
  "denials",
];

/** A Summary row picked to narrow the Timeline to its events. */
export interface RowFilter {
  group: StatsGroup;
  key: string;
}

export interface FileRow {
  key: string;
  reads: number;
  edits: number;
}

export interface CommandRow {
  key: string;
  runs: number;
  failures: number;
}

export interface DomainRow {
  key: string;
  visits: number;
  tools: string[];
}

export interface DenialRow {
  key: string;
  count: number;
  deniedBy: SessionEventDeniedBy[];
}

export interface SessionStatsSummary {
  files: { rows: FileRow[]; reads: number; edits: number };
  commands: { rows: CommandRow[]; runs: number; failures: number };
  external: { rows: DomainRow[]; visits: number };
  denials: { rows: DenialRow[]; count: number };
}

function ranked<R extends { key: string }>(
  map: Map<string, R>,
  count: (row: R) => number,
): R[] {
  return [...map.values()].sort(
    (a, b) =>
      count(b) - count(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

function rowFor<R>(map: Map<string, R>, key: string, create: () => R): R {
  let row = map.get(key);
  if (row === undefined) {
    row = create();
    map.set(key, row);
  }
  return row;
}

function addOnce<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

/** The tool a call reached a domain with: `curl` / `wget` for a shell command. */
export function externalTools(event: SessionEvent): string[] {
  if (event.tool === "Bash") {
    const programs = [...event.text.matchAll(/\b(curl|wget)\b/g)].map(
      (m) => m[1] ?? "",
    );
    const unique = [...new Set(programs)];
    return unique.length > 0 ? unique : ["Bash"];
  }
  return [event.tool?.split("__").pop() ?? event.kind];
}

/** The Summary rows of `group` an event counts toward; empty when it is not in the group. */
function rowKeys(event: SessionEvent, group: StatsGroup): readonly string[] {
  switch (group) {
    case "files":
      return (event.kind === "read" || event.kind === "edit") && event.target
        ? [event.target]
        : [];
    case "commands":
      return event.kind === "command" && event.target ? [event.target] : [];
    case "external":
      return event.domains ?? [];
    case "denials":
      return event.outcome === "denied" ? [event.text] : [];
  }
}

function inGroup(event: SessionEvent, group: StatsGroup): boolean {
  return rowKeys(event, group).length > 0;
}

function inRow(event: SessionEvent, { group, key }: RowFilter): boolean {
  return rowKeys(event, group).includes(key);
}

export function summarize(
  events: readonly SessionEvent[],
): SessionStatsSummary {
  const files = new Map<string, FileRow>();
  const commands = new Map<string, CommandRow>();
  const domains = new Map<string, DomainRow>();
  const denials = new Map<string, DenialRow>();
  let reads = 0;
  let edits = 0;
  let runs = 0;
  let failures = 0;
  let visits = 0;
  let denialCount = 0;

  for (const event of events) {
    for (const key of rowKeys(event, "files")) {
      const row = rowFor(files, key, () => ({ key, reads: 0, edits: 0 }));
      if (event.kind === "read") {
        row.reads += 1;
        reads += 1;
      } else {
        row.edits += 1;
        edits += 1;
      }
    }
    for (const key of rowKeys(event, "commands")) {
      const row = rowFor(commands, key, () => ({ key, runs: 0, failures: 0 }));
      row.runs += 1;
      runs += 1;
      if (event.outcome === "failed") {
        row.failures += 1;
        failures += 1;
      }
    }
    for (const key of rowKeys(event, "external")) {
      const row = rowFor(domains, key, () => ({ key, visits: 0, tools: [] }));
      row.visits += 1;
      visits += 1;
      for (const tool of externalTools(event)) addOnce(row.tools, tool);
    }
    for (const key of rowKeys(event, "denials")) {
      const row = rowFor(denials, key, () => ({
        key,
        count: 0,
        deniedBy: [],
      }));
      row.count += 1;
      denialCount += 1;
      if (event.deniedBy !== undefined) addOnce(row.deniedBy, event.deniedBy);
    }
  }

  return {
    files: { rows: ranked(files, (r) => r.reads + r.edits), reads, edits },
    commands: { rows: ranked(commands, (r) => r.runs), runs, failures },
    external: { rows: ranked(domains, (r) => r.visits), visits },
    denials: { rows: ranked(denials, (r) => r.count), count: denialCount },
  };
}

export function timelineEvents(
  events: readonly SessionEvent[],
  filter: TimelineFilter,
  row: RowFilter | null,
): SessionEvent[] {
  return events.filter(
    (event) =>
      (filter === "all" || inGroup(event, filter)) &&
      (row === null || inRow(event, row)),
  );
}

export function filterCounts(
  events: readonly SessionEvent[],
): Record<TimelineFilter, number> {
  const count = (group: StatsGroup) =>
    events.filter((event) => inGroup(event, group)).length;
  return {
    all: events.length,
    files: count("files"),
    commands: count("commands"),
    external: count("external"),
    denials: count("denials"),
  };
}

export function isHighlighted(event: SessionEvent): boolean {
  return event.outcome === "failed" || event.outcome === "denied";
}

const NOT_TOOL_CALLS: ReadonlySet<SessionEvent["kind"]> = new Set([
  "prompt",
  "interrupt",
  "compaction",
]);

export function isRunning(event: SessionEvent): boolean {
  return !NOT_TOOL_CALLS.has(event.kind) && event.outcome === undefined;
}

export function fmtClock(at: number): string {
  const time = new Date(at);
  return [time.getHours(), time.getMinutes(), time.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function fmtEventDuration(ms: number): string {
  return ms < 1_000 ? `${Math.max(0, Math.round(ms))}ms` : fmtDuration(ms);
}
