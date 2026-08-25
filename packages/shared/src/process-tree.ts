// Pure functions for claude sid discovery (tree search over ps output).
// Running ps is the responsibility of server/infra. This module only handles the ps output string and the tree search.

import { isUuidSid } from "./save-file.js";

const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const SID_ARG_RE = new RegExp(
  `(?:--session-id|--resume|-r) +(${UUID_PATTERN})`,
);

/**
 * Reads the session id from claude's launch arguments (the UUID following
 * --session-id / --resume / -r, lowercased; null if absent).
 */
export function sidFromArgs(args: string): string | null {
  const m = SID_ARG_RE.exec(args);
  return m?.[1] !== undefined ? m[1].toLowerCase() : null;
}

/**
 * Determines the identity sid used for display and rename. Prefers the sid read
 * from the running claude's argv (liveSid); if unavailable, falls back to the sid
 * stamped onto the window (stampedSid, UUID only).
 * In windows where the shell survives after claude exits, liveSid disappears, but
 * keeping the sid stamped at startup as the identity makes the custom title rename
 * remain effective for the window's lifetime.
 * stamped is not evidence that claude is alive, so it is not used for state detection (hasClaude).
 */
export function resolveIdentitySid(
  liveSid: string | null,
  stampedSid: string | undefined,
): string | undefined {
  if (liveSid !== null) return liveSid;
  if (stampedSid !== undefined && isUuidSid(stampedSid))
    return stampedSid.toLowerCase();
  return undefined;
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  args: string;
}

const WHITESPACE = /\s/;
const DIGITS = /^\d+$/;

interface PsColumn {
  text: string;
  /** Offset just past this column in the source line. */
  end: number;
}

/** Splits a line into whitespace-delimited columns without regex backtracking. */
function psColumns(line: string): PsColumn[] {
  const columns: PsColumn[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && WHITESPACE.test(line[i] ?? "")) i++;
    if (i >= line.length) break;
    const start = i;
    while (i < line.length && !WHITESPACE.test(line[i] ?? "")) i++;
    columns.push({ text: line.slice(start, i), end: i });
  }
  return columns;
}

/** Offset of the first non-whitespace char at or after `from` (clamped to length). */
function skipWhitespace(line: string, from: number): number {
  let i = from;
  while (i < line.length && WHITESPACE.test(line[i] ?? "")) i++;
  return i;
}

/**
 * Parses one ps line into pid/ppid/args (null when it is not a valid row).
 * `end < line.length` for the ppid column requires at least one whitespace
 * separator after it, so args (which keeps its original internal spacing) can be
 * empty only when the row ends in trailing whitespace — matching the old regex.
 */
function parsePsLine(line: string): ProcessEntry | null {
  const [c0, c1, c2] = psColumns(line);
  if (
    c0 &&
    c1 &&
    DIGITS.test(c0.text) &&
    DIGITS.test(c1.text) &&
    c1.end < line.length
  ) {
    return {
      pid: Number(c0.text),
      ppid: Number(c1.text),
      args: line.slice(skipWhitespace(line, c1.end)),
    };
  }
  if (
    c0 &&
    c1 &&
    c2 &&
    DIGITS.test(c1.text) &&
    DIGITS.test(c2.text) &&
    c2.end < line.length
  ) {
    return {
      pid: Number(c1.text),
      ppid: Number(c2.text),
      args: line.slice(skipWhitespace(line, c2.end)),
    };
  }
  return null;
}

/**
 * Parses ps output (invalid lines are skipped).
 * Accepts both `pid ppid args` (old) and `tty pid ppid args` (`-o tty=,...`)
 * formats: if the first column is numeric it is treated as pid (old); if non-numeric
 * it is treated as the tty column and one token is skipped.
 * The old format is never misread when args starts with a non-numeric word (the old format's first column is always a numeric pid).
 */
export function parsePsSnapshot(psOutput: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const entry = parsePsLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export interface ProcessMaps {
  /** pid → sid for claude processes (only those with a UUID in their arguments). */
  pidToSid: ReadonlyMap<number, string>;
  /** ppid → list of child pids. */
  childrenOf: ReadonlyMap<number, readonly number[]>;
}

/** Builds the sid lookup and parent-child tables from a ps snapshot (non-claude processes are not added to the sid table). */
export function buildProcessMaps(
  entries: readonly ProcessEntry[],
): ProcessMaps {
  const pidToSid = new Map<number, string>();
  const childrenOf = new Map<number, number[]>();
  for (const e of entries) {
    if (/claude/i.test(e.args)) {
      const sid = sidFromArgs(e.args);
      if (sid !== null) pidToSid.set(e.pid, sid);
    }
    const kids = childrenOf.get(e.ppid);
    if (kids) kids.push(e.pid);
    else childrenOf.set(e.ppid, [e.pid]);
  }
  return { pidToSid, childrenOf };
}

/**
 * BFS over the process tree, returning the sid of the first claude found (null if none).
 * visited guards against anomalous ps data (cycles).
 */
export function findSidInTree(
  startPid: number,
  maps: ProcessMaps,
): string | null {
  const queue: number[] = [startPid];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    const sid = maps.pidToSid.get(pid);
    if (sid !== undefined) return sid;
    for (const child of maps.childrenOf.get(pid) ?? []) queue.push(child);
  }
  return null;
}
