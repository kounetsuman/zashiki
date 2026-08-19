/**
 * Pure formatters and color thresholds for the session status footer. Kept free of React so the
 * display logic is unit-tested directly (the component only wires these to live-ticking `now`).
 */

/** Severity band shared by tokens and usage percentages; drives the footer's color classes. */
export type Severity = "" | "warn" | "high" | "crit";

/** Compact token count: exact below one thousand, otherwise one decimal with a thousands/millions suffix. */
export function fmtTokens(n: number): string {
  if (n < 1_000) return `${Math.max(0, Math.trunc(n))}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Elapsed duration, leading zero units dropped: `12s`, `3m 12s`, `1h 24m 5s`. Negative clamps to 0. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
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
