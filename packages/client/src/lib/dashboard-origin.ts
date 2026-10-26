import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The desktop window keeps itself and every frame in it on the origins Zashiki serves, refusing
 * the rest in place. Telling the shell the configured dashboard address whenever it changes lets
 * the overlay frame that page; an address that is not a web page withdraws the allowance. No-op
 * outside Tauri.
 */
export function allowDashboardOrigin(url: string): void {
  if (!isTauri()) return;
  void invoke("set_dashboard_origin", { url }).catch((e: unknown) => {
    console.warn("could not tell the shell the dashboard address", e);
  });
}
