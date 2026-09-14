import type { DashboardSettings, DashboardShowOn } from "@zashiki/shared";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for the address last shown and the calendar day it was shown on. */
export const DASHBOARD_LAST_SHOWN_KEY = "zk.dashboard.lastShown";

/** What brought the user back to the cockpit. */
export type DashboardTrigger = "launch" | "wake";

/** Local files load through the server; `file://` cannot be framed from the app's http origin. */
export type DashboardTarget =
  | { kind: "off" }
  | { kind: "remote"; url: string }
  | { kind: "local" };

export function dashboardTarget(url: string): DashboardTarget {
  const value = url.trim();
  if (value === "") return { kind: "off" };
  return /^https?:\/\//i.test(value)
    ? { kind: "remote", url: value }
    : { kind: "local" };
}

/** What the overlay has to draw: the page itself, or why it could not be read. */
export type DashboardFrame =
  | { kind: "remote"; url: string }
  | { kind: "local"; html: string }
  | { kind: "error"; detail: string };

/**
 * An opaque origin for every frame: sandbox flags are fixed for the frame's lifetime while the
 * document in it can navigate, so this is the only form under which no document the frame ever
 * holds can become same-origin with the cockpit and reach the app's token, storage, or API.
 */
export const DASHBOARD_SANDBOX = "allow-scripts";

/** The address and day the page was last shown, or null when it never was. */
export interface DashboardLastShown {
  url: string;
  day: string;
}

export function loadDashboardLastShown(
  storage: StoragePart | null,
): DashboardLastShown | null {
  const raw = storage?.getItem(DASHBOARD_LAST_SHOWN_KEY);
  if (raw === null || raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { url, day } = parsed as Partial<DashboardLastShown>;
    return typeof url === "string" && typeof day === "string"
      ? { url, day }
      : null;
  } catch {
    return null;
  }
}

export function saveDashboardLastShown(
  storage: StoragePart | null,
  lastShown: DashboardLastShown,
): void {
  try {
    storage?.setItem(DASHBOARD_LAST_SHOWN_KEY, JSON.stringify(lastShown));
  } catch {
    // ignore (private mode / quota); at worst the page shows again on the next trigger.
  }
}

/**
 * Whether a refused read should still spend the day at `once_per_day`. A 4xx says the setting names
 * something the server will keep refusing, so retrying on every wake would only nag; anything else
 * (offline, a server still starting) can succeed later today.
 */
export function dashboardFailureSpendsDay(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500;
}

/** The day `once_per_day` is keyed on. Local time, so the day turns over at the user's midnight. */
export function dashboardDayKey(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function showsOn(showOn: DashboardShowOn, trigger: DashboardTrigger): boolean {
  return showOn === "both" || showOn === trigger;
}

export function shouldShowDashboard(
  settings: DashboardSettings,
  trigger: DashboardTrigger,
  lastShown: DashboardLastShown | null,
  today: string,
): boolean {
  if (dashboardTarget(settings.url).kind === "off") return false;
  if (!showsOn(settings.showOn, trigger)) return false;
  if (settings.frequency === "every_time") return true;
  return lastShown?.day !== today || lastShown.url !== settings.url.trim();
}
