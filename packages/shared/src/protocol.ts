import { z } from "zod";

import { notificationSchema } from "./notifications.js";

/** Response returned by the server's /healthz endpoint. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Terminal view ID (expected to be a client-generated UUID).
 * Only alphanumerics and hyphens are allowed, since it is embedded in the tmux session name `zk-<termId>`.
 */
export const termIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/,
    "termId must be [A-Za-z0-9-] (max 64 chars)",
  );

export type TermId = z.infer<typeof termIdSchema>;

/**
 * Immutable session (window) ID. Its form differs by backend:
 * - tmux: canonical window ID `@N` (immutable across rename and renumber)
 * - owned: SessionRegistry's immutable ID (UUID)
 *
 * Both forms are accepted (restricting to only one would reject the entire
 * state.sync originating from owned, so new/restored sessions would never appear
 * in the list. The source of truth is protocol.test.ts).
 */
export const windowIdSchema = z
  .string()
  .regex(
    /^(@\d+|[A-Za-z0-9][A-Za-z0-9-]{0,127})$/,
    "windowId must be a tmux window_id (@N) or an owned session id",
  );

export type WindowId = z.infer<typeof windowIdSchema>;

/**
 * Session (window) state (detection lives in shared/session-state.ts).
 * "running_bg_agent" means the normal spinner is gone and only the agent-group
 * panel at the bottom remains, i.e. a subagent is running. "starting" is the
 * transient state right after restore/new where claude has not yet appeared in
 * the process tree (it resolves to "no_claude" once the grace period is exceeded).
 * "unknown" appears only when detection was skipped due to pane_in_mode (copy-mode etc.) and there is not yet a previous state to retain.
 */
export const sessionStateSchema = z.enum([
  "waiting_input",
  "running",
  "running_bg_agent",
  "idle",
  "no_claude",
  "starting",
  "unknown",
]);

export type SessionState = z.infer<typeof sessionStateSchema>;

/** Per-window snapshot distributed via state.sync. */
export const sessionInfoSchema = z.object({
  windowId: windowIdSchema,
  name: z.string(),
  org: z.string(),
  repo: z.string(),
  state: sessionStateSchema,
  /** First 30 characters of the first user utterance in the jsonl (null when there is no utterance or it cannot be read). */
  title: z.string().nullable(),
  /**
   * The running claude's session-id (sid; the key for the custom title, and also
   * used to build the client's resume command). Absent for windows where claude
   * is not started, when sid detection fails, or with old servers. optional for old-server compatibility.
   */
  sid: z.string().max(256).optional(),
  active: z.boolean(),
  /**
   * Total number of running subagents (including nested grandchildren and beyond).
   * An approximation counted by the mtime freshness of subagents/*.jsonl, meaningful
   * only when running_bg_agent (0 in other states or when not fetched). optional for old-server compatibility.
   */
  runningSubagents: z.number().int().min(0).optional(),
  /**
   * Number of persistent background shells (Bash run_in_background).
   * The count of tasks/<ID>.output files (held by the live wrapper's fd1) whose <ID>
   * matches a backgroundTaskId in the transcript. Orthogonal to the main state
   * (meaningful in any state). optional for old-server compatibility (not fetched, i.e. feature off, means absent).
   */
  shellsRunning: z.number().int().min(0).optional(),
  /**
   * Whether Claude Code's usage limit has been reached. Detected via the limit
   * banner text at the bottom of the screen (isLimitReached in shared/session-state.ts).
   * Orthogonal to the main state (meaningful in any state). optional for old-server compatibility (not sent is treated as false).
   */
  limited: z.boolean().optional(),
});

export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/**
 * Builds the resume command for forking a session.
 * Assumes the target terminal is already in the target repo, so it omits cd and is only `claude --resume <sid>`.
 * Returns null for sessions without a sid (claude not started or undetectable); the caller disables the menu.
 */
export function resumeCommand(session: {
  sid?: string | undefined;
}): string | null {
  const sid = session.sid;
  if (sid === undefined || sid === "") return null;
  return `claude --resume ${sid}`;
}

const colsSchema = z.number().int().min(1).max(10000);
const rowsSchema = z.number().int().min(1).max(10000);

// ---- client → server ----

export const termOpenSchema = z.object({
  t: z.literal("term.open"),
  termId: termIdSchema,
  windowId: windowIdSchema.optional(),
  cols: colsSchema,
  rows: rowsSchema,
});

export const termResizeSchema = z.object({
  t: z.literal("term.resize"),
  termId: termIdSchema,
  cols: colsSchema,
  rows: rowsSchema,
});

export const termSelectSchema = z.object({
  t: z.literal("term.select"),
  termId: termIdSchema,
  windowId: windowIdSchema,
});

export const termCloseSchema = z.object({
  t: z.literal("term.close"),
  termId: termIdSchema,
});

/**
 * client→server flow-control ACK (watermark scheme).
 * bytes is the amount xterm.js has finished writing (in UTF-16 code units; see shared/flow.ts).
 * An initial send with bytes=0 signals "this client sends ACKs"; on receiving it,
 * the server enables ACK-based pause for that term (clients that do not send it
 * continue to be controlled solely by ws.bufferedAmount as before).
 */
export const termAckSchema = z.object({
  t: z.literal("term.ack"),
  termId: termIdSchema,
  bytes: z.number().int().min(0).max(1_000_000_000),
});

export const sessionNewSchema = z.object({
  t: z.literal("session.new"),
  org: z.string().min(1),
});

export const sessionCloseSchema = z.object({
  t: z.literal("session.close"),
  windowId: windowIdSchema,
});

/** Manual refresh. The server re-evaluates immediately and returns state.sync to the requester. */
export const stateRefreshSchema = z.object({
  t: z.literal("state.refresh"),
});

/**
 * Manual dismissal of a notification (the ✕ in the NOTIFICATION panel). The server
 * removes only dismissible notifications and re-sends notifications.sync to all control clients.
 */
export const notificationDismissSchema = z.object({
  t: z.literal("notification.dismiss"),
  id: z.string().min(1),
});

/**
 * Config change from SETTINGS (currently the display language only). The server
 * persists it to config.json and, via watch, distributes config.sync to all connections.
 */
export const configUpdateSchema = z.object({
  t: z.literal("config.update"),
  language: z.enum(["ja", "en"]),
});

export const clientMessageSchema = z.discriminatedUnion("t", [
  termOpenSchema,
  termResizeSchema,
  termSelectSchema,
  termCloseSchema,
  termAckSchema,
  sessionNewSchema,
  sessionCloseSchema,
  stateRefreshSchema,
  notificationDismissSchema,
  configUpdateSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type NotificationDismissMessage = z.infer<
  typeof notificationDismissSchema
>;
export type ConfigUpdateMessage = z.infer<typeof configUpdateSchema>;
export type TermOpenMessage = z.infer<typeof termOpenSchema>;
export type TermAckMessage = z.infer<typeof termAckSchema>;

// ---- server → client ----

export const stateSyncSchema = z.object({
  t: z.literal("state.sync"),
  sessions: z.array(sessionInfoSchema),
  /** All orgs from repos.conf plus detected orgs (in display order). Orgs with zero sessions are not removed. */
  orgs: z.array(z.string()),
  /**
   * org name → display color (as noted in repos.conf). Unspecified orgs are absent (drawn with the default color).
   * Defaults to an empty map when omitted, for old-server compatibility (so state.sync is not dropped during rolling updates).
   */
  orgColors: z.record(z.string(), z.string()).default({}),
});

export const termReconnectSchema = z.object({
  t: z.literal("term.reconnect"),
  termIds: z.array(termIdSchema),
});

export const gitDirtySchema = z.object({
  t: z.literal("git.dirty"),
});

export const notifySchema = z.object({
  t: z.literal("notify"),
  kind: z.enum(["waiting", "done"]),
  windowId: windowIdSchema,
  title: z.string(),
});

export const errorMessageSchema = z.object({
  t: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

/**
 * Distribution of live-applied config. The server watches config.json and pushes
 * to all control clients on change. It also sends the current value once right after
 * connecting. The wire format is flat (the same shape as the config file / ZashikiConfig in shared/config).
 */
export const configSyncSchema = z.object({
  t: z.literal("config.sync"),
  notifySound: z.boolean(),
  debug: z.boolean(),
  /** Persisted display language (null when unset, i.e. deferred to the client's browser detection). */
  language: z.enum(["ja", "en"]).nullable().default(null),
});

/**
 * Full distribution of in-app notifications. The server pushes the notification
 * list it holds in memory to all control clients on change. It also sends the
 * current value once right after connecting (same manner as config.sync). It sends
 * the full set rather than a diff, and the client replaces the whole list (the count
 * is small, so it does not warrant the complexity of add/remove diffing).
 */
export const notificationsSyncSchema = z.object({
  t: z.literal("notifications.sync"),
  items: z.array(notificationSchema),
});

export const serverMessageSchema = z.discriminatedUnion("t", [
  stateSyncSchema,
  termReconnectSchema,
  gitDirtySchema,
  notifySchema,
  errorMessageSchema,
  configSyncSchema,
  notificationsSyncSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type StateSyncMessage = z.infer<typeof stateSyncSchema>;
export type NotifyMessage = z.infer<typeof notifySchema>;
export type ConfigSyncMessage = z.infer<typeof configSyncSchema>;
export type NotificationsSyncMessage = z.infer<typeof notificationsSyncSchema>;

// ---- Claude Code hooks → server（POST /api/hooks/event）----

/**
 * Hook event kind (hooks/notify-event.sh maps it from Claude Code's hook name).
 * prompt=UserPromptSubmit / tool=PostToolUse / waiting=Notification / done=Stop.
 */
export const hookEventKindSchema = z.enum([
  "prompt",
  "tool",
  "waiting",
  "done",
]);

export type HookEventKind = z.infer<typeof hookEventKindSchema>;

export const hookEventRequestSchema = z.object({
  kind: hookEventKindSchema,
  /** Claude Code's session_id (sid; the primary key for window resolution). */
  sid: z.string().max(256).optional(),
  /** The cwd at the time the hook fired (fallback key when resolution by sid fails). */
  cwd: z.string().max(4096).optional(),
});

export type HookEventRequest = z.infer<typeof hookEventRequestSchema>;

export const hookEventResponseSchema = z.object({
  ok: z.literal(true),
  /** Whether the event could be mapped to a work window (notifications are emitted only in this case). */
  matched: z.boolean(),
});

export type HookEventResponse = z.infer<typeof hookEventResponseSchema>;

// ---- REST（save / restore）----

export const sessionsSaveResponseSchema = z.object({
  saved: z.number().int().min(0),
  /** Names of windows skipped because the claude sid could not be detected. */
  skipped: z.array(z.string()),
  path: z.string(),
});

export type SessionsSaveResponse = z.infer<typeof sessionsSaveResponseSchema>;

export const sessionsRestoreRequestSchema = z.object({
  /** Filename within the saves directory (defaults to last.tsv when omitted). */
  file: z.string().min(1).optional(),
});

export type SessionsRestoreRequest = z.infer<
  typeof sessionsRestoreRequestSchema
>;

export const sessionsRestoreResponseSchema = z.object({
  restored: z.number().int().min(0),
  /** Warnings such as when a window was created but claude was not started (e.g. the sid is not a UUID). */
  warnings: z.array(z.string()),
  /** Backup written by the automatic save before kill (null if there was nothing to save). */
  backupPath: z.string().nullable(),
});

export type SessionsRestoreResponse = z.infer<
  typeof sessionsRestoreResponseSchema
>;
