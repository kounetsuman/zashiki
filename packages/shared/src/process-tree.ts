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

/**
 * Parses ps output (invalid lines are skipped).
 * Accepts both `pid ppid args` (old) and `tty pid ppid args` (`-o tty=,...`)
 * formats: if the first column is numeric it is treated as pid (old); if non-numeric
 * it is treated as the tty column and one token is skipped.
 * The old format is never misread when args starts with a non-numeric word (the old format's first column is always a numeric pid).
 */
export function parsePsSnapshot(psOutput: string): ProcessEntry[] {
  const withTty = /^\s*\S+\s+(\d+)\s+(\d+)\s+(.*)$/;
  const noTty = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
  const entries: ProcessEntry[] = [];
  for (const line of psOutput.split("\n")) {
    const m = noTty.exec(line) ?? withTty.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined)
      continue;
    entries.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
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
