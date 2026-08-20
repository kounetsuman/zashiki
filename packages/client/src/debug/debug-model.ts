import type { CockpitTerminalInfo, ServerMessage } from "@zashiki/shared";
import i18n from "../i18n/index.js";
import type { TermAttachStatus } from "../session/terminal-session.js";
import type { ControlStatus } from "../ws/control.js";

/**
 * Pure function that decides the initial on/off for debug mode.
 * On if either:
 * - a build-time flag (equivalent to ZK_DEBUG; `import.meta.env.VITE_ZK_DEBUG`), or
 * - the URL query `?debug=1` (explicitly added by the developer).
 * In release builds env is undefined/false, so it defaults to off.
 */
export function resolveDebugInitial(
  viteFlag: string | boolean | undefined,
  search: string,
): boolean {
  if (viteFlag === true || viteFlag === "1" || viteFlag === "true") return true;
  const v = new URLSearchParams(search).get("debug");
  return v === "1" || v === "true";
}

/** The tmux session name (zk-<termId>) used by term.select and others. */
export function tmuxSessionName(termId: string | null): string | null {
  return termId === null ? null : `zk-${termId}`;
}

/** Diagnostic snapshot of the control WS (the shape ControlClient.debugSnapshot() returns). */
export interface ControlDebugSnapshot {
  status: ControlStatus;
  /** Number of reconnect attempts since the latest disconnect (reset on open). */
  attempt: number;
  /** The last close code from a server-side disconnect (null if none). */
  lastCloseCode: number | null;
}

/** Diagnostic snapshot of the term WS (the shape TerminalSession.debugSnapshot() returns). */
export interface TermDebugSnapshot {
  status: TermAttachStatus;
  attempt: number;
  /** Number of unacked written characters (backpressure). */
  pendingAck: number;
  cockpitTerminalId: string | null;
  termId: string | null;
  suspended: boolean;
}

/** A log line for one message that flowed over the control WS. */
export interface ProtocolLogEntry {
  dir: "send" | "recv";
  /** Message discriminator (the t field). */
  t: string;
  /** Epoch milliseconds. */
  at: number;
}

/**
 * The control judgement for "minimal display only when abnormal".
 * `connecting` right after startup (attempt=0) and `open` are normal. Only states where
 * reconnect has failed and piled up (closed, or connecting with attempt>0) are abnormal.
 * Judging by status name alone would misdetect the startup moment, so attempt is used together.
 */
export function isControlAbnormal(
  status: ControlStatus,
  attempt: number,
): boolean {
  if (status === "open") return false;
  return attempt > 0;
}

/**
 * Whether to treat term as abnormal. idle is the normal empty state, attached is normal,
 * and opening/waiting-control/reconnecting are transitional so are not treated as abnormal.
 * Only disposed is abnormal (re-attach has failed). idle is excluded so status-name matching
 * does not misdetect the empty state.
 */
export function isTermAbnormal(status: TermAttachStatus): boolean {
  return status === "disposed";
}

/**
 * The minimal abnormal message shown in the normal footer (null when normal = show nothing).
 * Even when not in debug mode, say one word only when the connection is broken.
 */
export function footerAbnormalNotice(
  control: ControlDebugSnapshot,
  term: TermAttachStatus,
): string | null {
  const parts: string[] = [];
  if (isControlAbnormal(control.status, control.attempt)) {
    parts.push(`control ${control.status}`);
  }
  if (isTermAbnormal(term)) parts.push(`term ${term}`);
  return parts.length === 0
    ? null
    : i18n.t("terminal.connectionProblem", { detail: parts.join(" / ") });
}

/** Formats a state.sync snapshot for display as one line = one window. */
export function summarizeSessions(sessions: readonly CockpitTerminalInfo[]): {
  cockpitTerminalId: string;
  label: string;
  active: boolean;
  state: string;
}[] {
  return sessions.map((s) => ({
    cockpitTerminalId: s.cockpitTerminalId,
    label: `${s.org}/${s.repo} ${s.name}`,
    active: s.active,
    state: s.state,
  }));
}

/**
 * Formats the server->client messages worth keeping in the debug "hook event / state event"
 * log into a one-line string (null for those not kept).
 * - notify: from the hook's Notification(waiting)/Stop(done).
 * - git.dirty: refetch trigger from the hook's PostToolUse.
 * - term.reconnect: re-attach instruction after a restore.
 * - state.sync/error are visible in their own dedicated panes, so they are not added to the event log.
 */
export function describeServerEvent(m: ServerMessage): string | null {
  switch (m.t) {
    case "notify":
      return `notify ${m.kind} ${m.cockpitTerminalId} "${m.title}"`;
    case "git.dirty":
      return "git.dirty";
    case "term.reconnect":
      return `term.reconnect [${m.termIds.join(", ")}]`;
    default:
      return null;
  }
}

/** Pushes one entry onto the ring buffer and returns a new array that drops the oldest at the max cap (pure function). */
export function pushRing<T>(buf: readonly T[], entry: T, max: number): T[] {
  const next = [...buf, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
