import { z } from "zod";

/**
 * The notification categories that can be toggled independently in SETTINGS. `waiting` / `done` are
 * the Claude Code hook events; the rest are Background Activity edges emitted by the server poller.
 * Category keys are camelCase; the on-the-wire notify `kind` for the multi-word ones is snake_case
 * (`subagent_start`, …) — {@link notifyCategoryForKind} bridges the two.
 */
export const NOTIFY_CATEGORIES = [
  "waiting",
  "done",
  "subagentStart",
  "subagentEnd",
  "shellStart",
  "shellEnd",
] as const;

export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number];

/**
 * The selectable notification-sound presets. Each is a short synthesized motif (the tones live in the
 * client's notify-sound module). Ids are single lowercase words so the server's Rust `SoundPreset`
 * enum can mirror them with `serde(rename_all = "lowercase")` while staying `Copy`.
 */
export const SOUND_PRESETS = [
  "chime",
  "descend",
  "ping",
  "pong",
  "tick",
  "tock",
  "marimba",
  "bell",
] as const;

export type SoundPreset = (typeof SOUND_PRESETS)[number];

/** Fallback preset for an unknown category or a malformed stored value. */
export const DEFAULT_SOUND_PRESET: SoundPreset = "chime";

/** Per-category preference: whether to show the notification, whether to play a sound, and which sound. */
export interface NotifyCategoryPref {
  notify: boolean;
  sound: boolean;
  soundType: SoundPreset;
}

export interface NotificationSettings {
  /** Master switch; when false, no category shows or sounds. */
  enabled: boolean;
  categories: Record<NotifyCategory, NotifyCategoryPref>;
}

/**
 * waiting / done keep the historical on-by-default; the Background Activity edges are opt-in. Each
 * category's `soundType` reproduces its historical chirp, so upgrading changes nothing until a user
 * picks a different preset.
 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  categories: {
    waiting: { notify: true, sound: true, soundType: "descend" },
    done: { notify: true, sound: true, soundType: "chime" },
    subagentStart: { notify: false, sound: false, soundType: "ping" },
    subagentEnd: { notify: false, sound: false, soundType: "pong" },
    shellStart: { notify: false, sound: false, soundType: "tick" },
    shellEnd: { notify: false, sound: false, soundType: "tock" },
  },
};

function categoryPrefSchema(fallback: NotifyCategoryPref) {
  return z
    .object({
      notify: z.boolean().catch(fallback.notify).default(fallback.notify),
      sound: z.boolean().catch(fallback.sound).default(fallback.sound),
      soundType: z
        .enum(SOUND_PRESETS)
        .catch(fallback.soundType)
        .default(fallback.soundType),
    })
    .catch(fallback)
    .default(fallback);
}

const defaultCategory = (
  category: NotifyCategory,
): ReturnType<typeof categoryPrefSchema> =>
  categoryPrefSchema(DEFAULT_NOTIFICATION_SETTINGS.categories[category]);

export const notificationSettingsSchema = z
  .object({
    enabled: z.boolean().catch(true).default(true),
    categories: z
      .object({
        waiting: defaultCategory("waiting"),
        done: defaultCategory("done"),
        subagentStart: defaultCategory("subagentStart"),
        subagentEnd: defaultCategory("subagentEnd"),
        shellStart: defaultCategory("shellStart"),
        shellEnd: defaultCategory("shellEnd"),
      })
      .catch(DEFAULT_NOTIFICATION_SETTINGS.categories)
      .default(DEFAULT_NOTIFICATION_SETTINGS.categories),
  })
  .catch(DEFAULT_NOTIFICATION_SETTINGS)
  .default(DEFAULT_NOTIFICATION_SETTINGS);

/** Maps an on-the-wire notify `kind` to its settings category (null for an unknown kind). */
export function notifyCategoryForKind(kind: string): NotifyCategory | null {
  switch (kind) {
    case "waiting":
      return "waiting";
    case "done":
      return "done";
    case "subagent_start":
      return "subagentStart";
    case "subagent_end":
      return "subagentEnd";
    case "shell_start":
      return "shellStart";
    case "shell_end":
      return "shellEnd";
    default:
      return null;
  }
}

/**
 * Live-apply settings (`~/.zashiki/config.json`).
 * The server watches the file and pushes changes to all clients via `config.sync`.
 */
export const zashikiConfigSchema = z.object({
  /** Legacy single notification switch. Read only, for {@link parseConfig} migration; superseded by `notifications`. */
  notifySound: z.boolean().catch(true).default(true),
  /** Poll GitHub Releases for updates (defaults on). Set false to stop the server's outbound egress to github.com. */
  updateCheck: z.boolean().catch(true).default(true),
  /** Display language (selected in SETTINGS). null means unset, deferring to the client's browser detection. */
  language: z.enum(["ja", "en"]).nullable().catch(null).default(null),
  /** Per-category notification switches (master + show/sound per category). */
  notifications: notificationSettingsSchema,
});

export type ZashikiConfig = z.infer<typeof zashikiConfigSchema>;

export const DEFAULT_CONFIG: ZashikiConfig = {
  notifySound: true,
  updateCheck: true,
  language: null,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
};

/** A colored band of a status-footer indicator: whether it paints and the value at or above which it applies. */
export interface FooterBand {
  enabled: boolean;
  value: number;
}

/**
 * Per-indicator severity thresholds for the session/account status footer. Only the bands each
 * indicator renders exist here (usage warn/high/crit, tokens warn/crit, elapsed crit).
 */
export interface FooterThresholds {
  usagePercent: { warn: FooterBand; high: FooterBand; crit: FooterBand };
  sessionTokens: { warn: FooterBand; crit: FooterBand };
  elapsedMs: { crit: FooterBand };
}

/** Thresholds in effect until a config overrides them; the sole source of the default numbers. */
export const DEFAULT_FOOTER_THRESHOLDS: FooterThresholds = {
  usagePercent: {
    warn: { enabled: true, value: 50 },
    high: { enabled: true, value: 75 },
    crit: { enabled: true, value: 91 },
  },
  sessionTokens: {
    warn: { enabled: true, value: 1_500_000 },
    crit: { enabled: true, value: 3_000_000 },
  },
  elapsedMs: { crit: { enabled: true, value: 86_400_000 } },
};

function bandSchema(fallback: FooterBand) {
  return z
    .object({
      enabled: z.boolean().catch(fallback.enabled).default(fallback.enabled),
      value: z
        .number()
        .int()
        .nonnegative()
        .catch(fallback.value)
        .default(fallback.value),
    })
    .catch(fallback)
    .default(fallback);
}

function indicatorSchema<T extends Record<string, FooterBand>>(fallback: T) {
  const shape = Object.fromEntries(
    Object.entries(fallback).map(([band, def]) => [band, bandSchema(def)]),
  ) as { [K in keyof T]: ReturnType<typeof bandSchema> };
  return z.object(shape).catch(fallback).default(fallback);
}

/**
 * Every field falls back to its default on missing or malformed input, merged per-field, so a stale
 * or partially hand-edited config never breaks the footer.
 */
export const footerThresholdsSchema = z
  .object({
    usagePercent: indicatorSchema(DEFAULT_FOOTER_THRESHOLDS.usagePercent),
    sessionTokens: indicatorSchema(DEFAULT_FOOTER_THRESHOLDS.sessionTokens),
    elapsedMs: indicatorSchema(DEFAULT_FOOTER_THRESHOLDS.elapsedMs),
  })
  .catch(DEFAULT_FOOTER_THRESHOLDS)
  .default(DEFAULT_FOOTER_THRESHOLDS);

/** Notification channel (equivalent to ZK_NOTIFY). */
export const notifyModeSchema = z.enum(["web", "macos", "both"]);

export type NotifyMode = z.infer<typeof notifyModeSchema>;

/**
 * Restart-required settings (`~/.zashiki/config.startup.json`).
 * Read once at server startup. Not applied live.
 */
export const startupConfigSchema = z.object({
  /** Notification channel. If the ZK_NOTIFY env var is set, it takes precedence (resolved on the server side). */
  notifyMode: notifyModeSchema.optional(),
});

export type StartupConfig = z.infer<typeof startupConfigSchema>;

export const DEFAULT_STARTUP_CONFIG: StartupConfig = {};

/**
 * Safely interprets the live-apply settings. Does not throw; invalid or missing values
 * fall back to defaults (fallback contract). Individual fields are defaulted via the
 * schema's `.catch()`, and when the whole object is not an object it also falls back to defaults.
 */
export function parseConfig(input: unknown): ZashikiConfig {
  const result = zashikiConfigSchema.safeParse(input ?? {});
  const config = result.success ? result.data : { ...DEFAULT_CONFIG };
  return migrateLegacyNotifySound(input, config);
}

/**
 * Maps a legacy `notifySound: false` (with no `notifications` block) to the master being off. An
 * explicit `notifications` always wins.
 */
function migrateLegacyNotifySound(
  input: unknown,
  config: ZashikiConfig,
): ZashikiConfig {
  if (typeof input !== "object" || input === null) return config;
  const raw = input as Record<string, unknown>;
  if (raw.notifications !== undefined || raw.notifySound !== false) {
    return config;
  }
  return {
    ...config,
    notifications: { ...config.notifications, enabled: false },
  };
}

/** Safely interprets the restart-required settings (invalid or missing values fall back to defaults). */
export function parseStartupConfig(input: unknown): StartupConfig {
  const result = startupConfigSchema.safeParse(input ?? {});
  return result.success ? result.data : { ...DEFAULT_STARTUP_CONFIG };
}
