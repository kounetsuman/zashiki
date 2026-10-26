import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The desktop window refuses to navigate to origins Zashiki does not serve, frames included, so the
 * shell is told which dashboard address the overlay may frame. An address that is not a web page
 * withdraws the allowance. No-op outside Tauri.
 */
export function allowDashboardOrigin(url: string): void {
  if (!isTauri()) return;
  void invoke("set_dashboard_origin", { url }).catch(() => undefined);
}
