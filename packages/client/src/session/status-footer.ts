/**
 * Pure formatters and color thresholds for the session status footer. Kept free of React so the
 * display logic is unit-tested directly (the component only wires these to live-ticking `now`).
 */

import type { UsageLimit, UsageLimits } from "@zashiki/shared";

/** Severity band shared by tokens and usage percentages; drives the footer's color classes. */
export type Severity = "" | "warn" | "high" | "crit";

/** Compact token count: exact below one thousand, otherwise one decimal with a thousands/millions suffix. */
export function fmtTokens(n: number): string {
  if (n < 1_000) return `${Math.max(0, Math.trunc(n))}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A full day in ms; elapsed at or beyond this reads as critical (a run that has spanned a day). */
export const ONE_DAY_MS = 86_400_000;

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

/** Elapsed severity: critical once a full day has passed, otherwise none. */
export function durationSeverity(ms: number): Severity {
  return ms >= ONE_DAY_MS ? "crit" : "";
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

/** Percentage severity mirroring the statusline bands: 50/75/91 boundaries. */
export function usageSeverity(percent: number): Severity {
  if (percent >= 91) return "crit";
  if (percent >= 75) return "high";
  if (percent >= 50) return "warn";
  return "";
}

/** Raw-token severity from the measured p90/p95 of daily usage (1.5M warn, 3M crit). */
export function tokenSeverity(n: number): Severity {
  if (n >= 3_000_000) return "crit";
  if (n >= 1_500_000) return "warn";
  return "";
}

/**
 * Account usage is global to the Claude account, yet each session reports it independently via the
 * statusLine bridge. Collapse the sessions to one reading per limit by taking the highest usedPercent
 * seen (usage climbs monotonically within a window), carrying that reading's reset time. Returns null
 * when no session carries limits yet, so the global footer indicator stays hidden until data arrives.
 */
export function pickAccountLimits(
  sessions: readonly {
    usage?: { limits?: UsageLimits } | null | undefined;
  }[],
): UsageLimits | null {
  let fiveHour: UsageLimit | undefined;
  let week: UsageLimit | undefined;
  for (const session of sessions) {
    const limits = session.usage?.limits;
    if (!limits) continue;
    if (
      limits.fiveHour &&
      (!fiveHour || limits.fiveHour.usedPercent > fiveHour.usedPercent)
    )
      fiveHour = limits.fiveHour;
    if (limits.week && (!week || limits.week.usedPercent > week.usedPercent))
      week = limits.week;
  }
  if (!fiveHour && !week) return null;
  return { fiveHour, week };
}
