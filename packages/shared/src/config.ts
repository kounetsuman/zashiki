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
