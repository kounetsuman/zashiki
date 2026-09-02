/**
 * Pure formatters and color thresholds for the session status footer. Kept free of React so the
 * display logic is unit-tested directly (the component only wires these to live-ticking `now`).
 */

import {
  DEFAULT_FOOTER_THRESHOLDS,
  type FooterBand,
  type FooterThresholds,
  type UsageLimit,
  type UsageLimits,
} from "@zashiki/shared";

/** Severity band shared by tokens and usage percentages; drives the footer's color classes. */
export type Severity = "" | "warn" | "high" | "crit";

/** Compact token count: exact below one thousand, otherwise one decimal with a thousands/millions suffix. */
export function fmtTokens(n: number): string {
  if (n < 1_000) return `${Math.max(0, Math.trunc(n))}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Elapsed duration, leading zero units dropped: `12s`, `3m 12s`, `1h 24m 5s`, `2d 3h 4m 5s`. Negative clamps to 0. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (d > 0 || h > 0) parts.push(`${h}h`);
  if (d > 0 || h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/** Elapsed severity: crit once the (enabled) threshold is reached, otherwise none. */
export function durationSeverity(
  ms: number,
  t: FooterThresholds["elapsedMs"] = DEFAULT_FOOTER_THRESHOLDS.elapsedMs,
): Severity {
  return t.crit.enabled && ms >= t.crit.value ? "crit" : "";
}

/** Reset countdown, minute resolution: `23m`, `1h 03m`. Under a minute reads `<1m`. Negative clamps to 0. */
export function fmtResetCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/**
 * Reset countdown at full day-to-second precision, non-leading units zero-padded and space-separated:
 * `6d 08h 02m 03s`. The weekly window spans days, so its cell always carries days and live-ticking
 * seconds rather than the coarse minute resolution of {@link fmtResetCountdown}. Negative clamps to 0.
 */
export function fmtWeekResetCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

/** Which time an account-usage cell shows: how long until the window resets, or how long since it opened. */
export type UsageTimeMode = "remaining" | "elapsed";

/**
 * Fixed lengths of Claude Code's usage windows. Elapsed isn't reported directly, so it's derived as
 * `window − remaining`; these spans are what that derivation needs.
 */
export const FIVE_HOUR_WINDOW_MS = 5 * 3_600_000;
export const WEEK_WINDOW_MS = 7 * 86_400_000;

/**
 * Milliseconds a usage cell feeds its countdown formatter. `remaining` is the raw time to reset
 * (`resetsAt − now`); `elapsed` is time since the window opened, derived as `windowMs − remaining` and
 * clamped into `[0, windowMs]` so a reading past its reset stays inside the window.
 */
export function usageDisplayMs(
  mode: UsageTimeMode,
  resetsAt: number,
  now: number,
  windowMs: number,
): number {
  const remaining = resetsAt - now;
  if (mode === "remaining") return remaining;
  return Math.max(0, Math.min(windowMs, windowMs - remaining));
}

/** The other mode; the footer's gauge icon toggles between the two. */
export function nextUsageTimeMode(mode: UsageTimeMode): UsageTimeMode {
  return mode === "remaining" ? "elapsed" : "remaining";
}

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for the account-usage time mode (client-only; follows the "zk.*" convention). */
export const USAGE_TIME_MODE_KEY = "zk.footer.usageTimeMode";

/** Persisted time mode, defaulting to `remaining` when unset or unrecognized. */
export function loadUsageTimeMode(storage: StoragePart | null): UsageTimeMode {
  return storage?.getItem(USAGE_TIME_MODE_KEY) === "elapsed"
    ? "elapsed"
    : "remaining";
}

export function saveUsageTimeMode(
  storage: StoragePart | null,
  mode: UsageTimeMode,
): void {
  storage?.setItem(USAGE_TIME_MODE_KEY, mode);
}

/** Percentage severity; a disabled band is skipped so the reading falls through to the next lower enabled band. */
export function usageSeverity(
  percent: number,
  t: FooterThresholds["usagePercent"] = DEFAULT_FOOTER_THRESHOLDS.usagePercent,
): Severity {
  if (t.crit.enabled && percent >= t.crit.value) return "crit";
  if (t.high.enabled && percent >= t.high.value) return "high";
  if (t.warn.enabled && percent >= t.warn.value) return "warn";
  return "";
}

/** Raw-token severity; a disabled band is skipped so the reading falls through to the next lower enabled band. */
export function tokenSeverity(
  n: number,
  t: FooterThresholds["sessionTokens"] = DEFAULT_FOOTER_THRESHOLDS.sessionTokens,
): Severity {
  if (t.crit.enabled && n >= t.crit.value) return "crit";
  if (t.warn.enabled && n >= t.warn.value) return "warn";
  return "";
}

/**
 * While a limit banner is on screen, the statusLine percent is stale (it only advances on a
 * successful request), so the banner wins: force the five-hour percent to 100, keeping `resetsAt`.
 */
export function clampFiveHourWhenLimited(
  limits: UsageLimits | null,
  limited: boolean,
): UsageLimits | null {
  if (!limited || !limits?.fiveHour) return limits;
  return {
    ...limits,
    fiveHour: { ...limits.fiveHour, usedPercent: 100 },
  };
}

export interface ResetClockOpts {
  now: number;
  locale?: string;
  timeZone?: string;
}

const CLOCK_OPTS = {
  time: { hour: "2-digit", minute: "2-digit" },
  weekday: { weekday: "short" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function clockPart(
  ms: number,
  locale: string | undefined,
  timeZone: string | undefined,
  kind: keyof typeof CLOCK_OPTS,
): string {
  const key = `${locale ?? ""}|${timeZone ?? ""}|${kind}`;
  let fmt = clockFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { ...CLOCK_OPTS[kind], timeZone });
    clockFormatters.set(key, fmt);
  }
  return fmt.format(ms);
}

/**
 * Absolute local time a usage window resets at, for the footer tooltip. Within a day of `now` it reads
 * as a bare clock (`15:30`); further out it prefixes the weekday (`Wed 15:30`) since the weekly window
 * sits days away. The clock follows the locale (a 12-hour locale renders `03:30 PM`). `locale`/`timeZone`
 * default to the runtime's and are injectable so the format is unit-tested deterministically.
 */
export function fmtResetClock(
  ms: number,
  { now, locale, timeZone }: ResetClockOpts,
): string {
  const time = clockPart(ms, locale, timeZone, "time");
  if (ms - now < 86_400_000) return time;
  return `${clockPart(ms, locale, timeZone, "weekday")} ${time}`;
}

/** How long a reading may go unrefreshed before the footer treats it as possibly stale (ms). */
export const USAGE_STALE_AFTER_MS = 90_000;

/** Freshness of one usage cell; drives whether the footer dims the value and drops its countdown. */
export type UsageFreshness = "live" | "stale" | "expired";

/**
 * How current a usage cell's reading is — it only advances when a hook-registered Claude Code session
 * takes a turn, so it can lag reality (usage spent in the web app, or a terminal left idle). `expired`
 * drops the now-meaningless countdown; `stale` dims a possibly-behind value. `capturedAt` is the
 * reading's receipt time; an absent cell is `live` (it renders a dash).
 */
export function usageFreshness(
  limit: UsageLimit | undefined,
  capturedAt: number | undefined,
  now: number,
): UsageFreshness {
  if (limit === undefined) return "live";
  if (limit.resetsAt !== undefined && now >= limit.resetsAt) return "expired";
  if (capturedAt !== undefined && now - capturedAt > USAGE_STALE_AFTER_MS) {
    return "stale";
  }
  return "live";
}

/** Whether a limit has reached an enabled band's value — the gate for painting crit and raising the near-limit warning. */
export function usageBandReached(
  limit: UsageLimit | undefined,
  band: FooterBand,
): boolean {
  return limit !== undefined && band.enabled && limit.usedPercent >= band.value;
}

/** Headroom left before lockout, clamped to 0..100. Drives the warning's "locked out in {n}%" copy. */
export function usageRemainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}
