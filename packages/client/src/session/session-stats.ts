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
    const { target } = event;
    if ((event.kind === "read" || event.kind === "edit") && target) {
      const row = rowFor(files, target, () => ({
        key: target,
        reads: 0,
        edits: 0,
      }));
      if (event.kind === "read") {
        row.reads += 1;
        reads += 1;
      } else {
        row.edits += 1;
        edits += 1;
      }
    }
    if (event.kind === "command" && target) {
      const row = rowFor(commands, target, () => ({
        key: target,
        runs: 0,
        failures: 0,
      }));
      row.runs += 1;
      runs += 1;
      if (event.outcome === "failed") {
        row.failures += 1;
        failures += 1;
      }
    }
    for (const domain of event.domains ?? []) {
      const row = rowFor(domains, domain, () => ({
        key: domain,
        visits: 0,
        tools: [],
      }));
      row.visits += 1;
      visits += 1;
      for (const tool of externalTools(event)) addOnce(row.tools, tool);
    }
    if (event.outcome === "denied") {
      const row = rowFor(denials, event.text, () => ({
        key: event.text,
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

function inGroup(event: SessionEvent, group: StatsGroup): boolean {
  switch (group) {
    case "files":
      return event.kind === "read" || event.kind === "edit";
    case "commands":
      return event.kind === "command";
    case "external":
      return (event.domains?.length ?? 0) > 0;
    case "denials":
      return event.outcome === "denied";
  }
}

function inRow(event: SessionEvent, { group, key }: RowFilter): boolean {
  if (!inGroup(event, group)) return false;
  switch (group) {
    case "files":
    case "commands":
      return event.target === key;
    case "external":
      return event.domains?.includes(key) ?? false;
    case "denials":
      return event.text === key;
  }
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
