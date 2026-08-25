/**
 * Pure formatters and color thresholds for the session status footer. Kept free of React so the
 * display logic is unit-tested directly (the component only wires these to live-ticking `now`).
 */

import {
  DEFAULT_FOOTER_THRESHOLDS,
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

/** Reset countdown, minute resolution: `23m`, `1h23m`. Under a minute reads `<1m`. Negative clamps to 0. */
export function fmtResetCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/**
 * Reset countdown at full day-to-second precision, non-leading units zero-padded: `6d08h02m03s`.
 * The weekly window spans days, so its cell always carries days and live-ticking seconds rather than
 * the coarse minute resolution of {@link fmtResetCountdown}. Negative clamps to 0.
 */
export function fmtWeekResetCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d}d${pad(h)}h${pad(m)}m${pad(s)}s`;
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
 * Account usage is global to the Claude account, yet each session reports it independently via the
 * statusLine bridge. Collapse the cockpit terminals to one reading per limit by taking the freshest
 * `updatedAt` seen, so the reading from whichever session most recently did something wins. Returns
 * null when no session carries limits yet, so the global footer indicator stays hidden.
 */
export function pickAccountLimits(
  cockpitTerminals: readonly {
    usage?: { limits?: UsageLimits } | null | undefined;
  }[],
): UsageLimits | null {
  let fiveHour: UsageLimit | undefined;
  let fiveHourAt = Number.NEGATIVE_INFINITY;
  let week: UsageLimit | undefined;
  let weekAt = Number.NEGATIVE_INFINITY;
  for (const session of cockpitTerminals) {
    const limits = session.usage?.limits;
    if (!limits) continue;
    const at = limits.updatedAt ?? 0;
    if (limits.fiveHour && at >= fiveHourAt) {
      fiveHour = limits.fiveHour;
      fiveHourAt = at;
    }
    if (limits.week && at >= weekAt) {
      week = limits.week;
      weekAt = at;
    }
  }
  if (!fiveHour && !week) return null;
  return { fiveHour, week };
}
