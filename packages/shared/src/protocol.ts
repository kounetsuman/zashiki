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
 * state.sync originating from owned, so new/restored cockpit terminals would never appear
 * in the list. The source of truth is protocol.test.ts).
 */
export const cockpitTerminalIdSchema = z
  .string()
  .regex(
    /^(@\d+|[A-Za-z0-9][A-Za-z0-9-]{0,127})$/,
    "cockpitTerminalId must be a tmux window_id (@N) or an owned session id",
  );

export type CockpitTerminalId = z.infer<typeof cockpitTerminalIdSchema>;

/**
 * Session (window) state (detection lives in shared/session-state.ts).
 * "running_bg_agent" means the normal spinner is gone and only the agent-group
 * panel at the bottom remains, i.e. a subagent is running. "starting" is the
 * transient state right after restore/new where claude has not yet appeared in
 * the process tree (it resolves to "no_claude" once the grace period is exceeded).
 * "unknown" appears only when detection was skipped due to pane_in_mode (copy-mode etc.) and there is not yet a previous state to retain.
 */
export const cockpitTerminalStateSchema = z.enum([
  "waiting_input",
  "running",
  "running_bg_agent",
  "idle",
  "no_claude",
  "starting",
  "unknown",
]);

export type CockpitTerminalState = z.infer<typeof cockpitTerminalStateSchema>;

/**
 * One account usage limit: the rounded used percentage and, when known, the epoch-ms reset time.
 * Filled from the statusLine bridge; the footer renders a live reset countdown from `resetsAt`.
 */
export const usageLimitSchema = z.object({
  usedPercent: z.number().int().min(0),
  resetsAt: z.number().int().optional(),
});

export type UsageLimit = z.infer<typeof usageLimitSchema>;

/** Account usage limits Claude Code exposes to its statusLine (5-hour window and weekly). */
export const usageLimitsSchema = z.object({
  fiveHour: usageLimitSchema.optional(),
  week: usageLimitSchema.optional(),
});

export type UsageLimits = z.infer<typeof usageLimitsSchema>;

/**
 * Session status-footer material. `turn*` counts from the most recent human prompt; `session*` spans
 * the whole transcript. `*StartedAt` are epoch ms — the client renders live elapsed as `now - start`.
 * Tokens/timestamps derive from the transcript (no user setup); `limits` arrives via the statusLine bridge.
 */
export const sessionUsageSchema = z.object({
  turnTokens: z.number().int().min(0),
  sessionTokens: z.number().int().min(0),
  turnStartedAt: z.number().int(),
  sessionStartedAt: z.number().int(),
  limits: usageLimitsSchema.optional(),
});

export type SessionUsage = z.infer<typeof sessionUsageSchema>;

/** Per-window snapshot distributed via state.sync. */
export const cockpitTerminalInfoSchema = z.object({
  cockpitTerminalId: cockpitTerminalIdSchema,
  name: z.string(),
  org: z.string(),
  repo: z.string(),
  state: cockpitTerminalStateSchema,
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
  /**
   * Token totals and elapsed anchors for the session status footer. Absent for old servers or when
   * the transcript can't be read; `limits` inside is present only when the statusLine bridge is set up.
   */
  usage: sessionUsageSchema.optional(),
});

export type CockpitTerminalInfo = z.infer<typeof cockpitTerminalInfoSchema>;

/**
 * The running claude's session id (sid), for copying to the clipboard verbatim.
 * Returns null for cockpit terminals without a sid (claude not started or undetectable); the caller disables the menu.
 */
export function claudeSessionId(session: {
  sid?: string | undefined;
}): string | null {
  const sid = session.sid;
  if (sid === undefined || sid === "") return null;
  return sid;
}

const colsSchema = z.number().int().min(1).max(10000);
const rowsSchema = z.number().int().min(1).max(10000);

// ---- client → server ----

export const termOpenSchema = z.object({
  t: z.literal("term.open"),
  termId: termIdSchema,
  cockpitTerminalId: cockpitTerminalIdSchema.optional(),
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
  cockpitTerminalId: cockpitTerminalIdSchema,
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

export const cockpitTerminalNewSchema = z.object({
  t: z.literal("cockpitTerminal.new"),
  org: z.string().min(1),
  /** Source Claude session id to fork into the new terminal (duplicate). Omitted for a plain new session. */
  resumeSid: z.string().max(256).optional(),
});

export const cockpitTerminalCloseSchema = z.object({
  t: z.literal("cockpitTerminal.close"),
  cockpitTerminalId: cockpitTerminalIdSchema,
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

/**
 * Opt-in toggle for the account-usage bridge (SETTINGS / the footer modal). The server persists it to
 * config.json and distributes config.sync; the launch-time statusLine injection reads it per launch.
 */
export const configSetAccountUsageSchema = z.object({
  t: z.literal("config.setAccountUsage"),
  enabled: z.boolean(),
});

/**
 * Install zashiki's Claude Code hooks + statusLine into ~/.claude/settings.json (first-run wizard
 * or SETTINGS). Idempotent; the server broadcasts the resulting `hooks.status`.
 */
export const hooksRegisterSchema = z.object({
  t: z.literal("hooks.register"),
});

/**
 * Remove only zashiki's entries from ~/.claude/settings.json (restoring any wrapped legacy
 * statusLine). The server broadcasts the resulting `hooks.status`.
 */
export const hooksUnregisterSchema = z.object({
  t: z.literal("hooks.unregister"),
});

/**
 * On-demand "Check for updates" from SETTINGS. The server checks GitHub Releases immediately
 * and replies with `update.check.result`; a newer version also arrives as a notification.
 */
export const updateCheckSchema = z.object({
  t: z.literal("update.check"),
});

/**
 * Trigger a self-update from the header Update button. On a Homebrew-cask desktop install the server
 * runs `brew upgrade --cask zashiki` and relaunches; otherwise it opens the releases page. Progress
 * arrives via `update.status`.
 */
export const updatePerformSchema = z.object({
  t: z.literal("update.perform"),
});

export const clientMessageSchema = z.discriminatedUnion("t", [
  termOpenSchema,
  termResizeSchema,
  termSelectSchema,
  termCloseSchema,
  termAckSchema,
  cockpitTerminalNewSchema,
  cockpitTerminalCloseSchema,
  stateRefreshSchema,
  notificationDismissSchema,
  configUpdateSchema,
  configSetAccountUsageSchema,
  hooksRegisterSchema,
  hooksUnregisterSchema,
  updateCheckSchema,
  updatePerformSchema,
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
  cockpitTerminals: z.array(cockpitTerminalInfoSchema),
  /** All orgs from repos.conf plus detected orgs (in display order). Orgs with zero cockpit terminals are not removed. */
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
  cockpitTerminalId: cockpitTerminalIdSchema,
  title: z.string(),
});

/**
 * Selects (brings to the front) a window without showing a notification. Unlike
 * `notify`, this drives selection directly — it is broadcast when an external caller
 * (e.g. a clicked desktop notification, via POST /api/focus) asks to focus a session.
 */
export const selectSchema = z.object({
  t: z.literal("select"),
  cockpitTerminalId: cockpitTerminalIdSchema,
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
  /** Whether the server polls GitHub Releases for updates (defaults on; omitted by old servers). */
  updateCheck: z.boolean().catch(true).default(true),
  /** Persisted display language (null when unset, i.e. deferred to the client's browser detection). */
  language: z.enum(["ja", "en"]).nullable().default(null),
  /** Whether the account-usage bridge is opted in (defaults off; omitted by old servers). */
  accountUsage: z.boolean().catch(false).default(false),
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

/**
 * Whether zashiki's Claude Code integration is present in ~/.claude/settings.json. Sent right after
 * connecting and after each register/unregister. Drives the first-run wizard and the SETTINGS toggle.
 * `statusLineConflict` means a non-zashiki statusLine occupies the slot (registering wraps it to
 * preserve it). Booleans default off for old-server compatibility.
 */
export const hooksStatusSchema = z.object({
  t: z.literal("hooks.status"),
  hooksRegistered: z.boolean().catch(false).default(false),
  statusLineRegistered: z.boolean().catch(false).default(false),
  statusLineConflict: z.boolean().catch(false).default(false),
});

/**
 * Reply to `update.check`, sent only to the requester so SETTINGS can show feedback.
 * `version` is the newer version when `status` is `"available"`, and null otherwise.
 */
export const updateCheckResultSchema = z.object({
  t: z.literal("update.check.result"),
  status: z.enum(["available", "upToDate", "error"]),
  version: z.string().nullable(),
});

/**
 * Progress of an `update.perform`, broadcast to all connections. `running` while brew works,
 * `relaunching` once it succeeds and the app is about to quit and reopen, `opened` when the env is
 * not a cask install so the releases page was opened instead, `failed` on error (`detail` carries
 * the brew stderr tail; null otherwise).
 */
export const updateStatusSchema = z.object({
  t: z.literal("update.status"),
  state: z.enum(["running", "relaunching", "opened", "failed"]),
  detail: z.string().nullable(),
});

export const serverMessageSchema = z.discriminatedUnion("t", [
  stateSyncSchema,
  termReconnectSchema,
  gitDirtySchema,
  notifySchema,
  selectSchema,
  errorMessageSchema,
  configSyncSchema,
  notificationsSyncSchema,
  hooksStatusSchema,
  updateCheckResultSchema,
  updateStatusSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type HooksStatusMessage = z.infer<typeof hooksStatusSchema>;
export type SelectMessage = z.infer<typeof selectSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type StateSyncMessage = z.infer<typeof stateSyncSchema>;
export type NotifyMessage = z.infer<typeof notifySchema>;
export type ConfigSyncMessage = z.infer<typeof configSyncSchema>;
export type NotificationsSyncMessage = z.infer<typeof notificationsSyncSchema>;
export type UpdateCheckResultMessage = z.infer<typeof updateCheckResultSchema>;
export type UpdateStatusMessage = z.infer<typeof updateStatusSchema>;
export type UpdateStatusState = UpdateStatusMessage["state"];

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

// ---- notification click → server（POST /api/focus）----

/**
 * Request a session be brought to the front, resolving the window the same way hook
 * events do (sid first, cwd as fallback). Sent when a native desktop notification is
 * clicked, so the originating session can be selected in an already-open app.
 */
export const focusRequestSchema = z.object({
  /** Claude Code's session_id (sid; the primary key for window resolution). */
  sid: z.string().max(256).optional(),
  /** The cwd of the session (fallback key when resolution by sid fails). */
  cwd: z.string().max(4096).optional(),
});

export type FocusRequest = z.infer<typeof focusRequestSchema>;

export const focusResponseSchema = z.object({
  /** Whether the request mapped to a live window (a `select` was broadcast only then). */
  resolved: z.boolean(),
  /** The resolved window id (absent when unresolved); lets the caller decide how to raise the app. */
  cockpitTerminalId: cockpitTerminalIdSchema.optional(),
});

export type FocusResponse = z.infer<typeof focusResponseSchema>;

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
