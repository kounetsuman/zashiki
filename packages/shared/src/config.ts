import { z } from "zod";

/**
 * Live-apply settings (`~/.zashiki/config.json`).
 * The server watches the file and pushes changes to all clients via `config.sync`.
 */
export const zashikiConfigSchema = z.object({
  /** Notification sound on/off. */
  notifySound: z.boolean().catch(true).default(true),
  /** Poll GitHub Releases for updates (defaults on). Set false to stop the server's outbound egress to github.com. */
  updateCheck: z.boolean().catch(true).default(true),
  /** Display language (selected in SETTINGS). null means unset, deferring to the client's browser detection. */
  language: z.enum(["ja", "en"]).nullable().catch(null).default(null),
});

export type ZashikiConfig = z.infer<typeof zashikiConfigSchema>;

export const DEFAULT_CONFIG: ZashikiConfig = {
  notifySound: true,
  updateCheck: true,
  language: null,
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
  return result.success ? result.data : { ...DEFAULT_CONFIG };
}

/** Safely interprets the restart-required settings (invalid or missing values fall back to defaults). */
export function parseStartupConfig(input: unknown): StartupConfig {
  const result = startupConfigSchema.safeParse(input ?? {});
  return result.success ? result.data : { ...DEFAULT_STARTUP_CONFIG };
}
