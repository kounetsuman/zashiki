import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The desktop window keeps itself and every frame in it on the origins Zashiki serves, refusing
 * the rest in place. Telling the shell the configured dashboard address lets the overlay frame
 * that page; an address that is not a web page withdraws the allowance. Settles once the shell
 * has it (at once outside Tauri); a failure is reported and settles too, as there is nothing
 * better to wait for.
 */
export async function registerDashboardOrigin(url: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_dashboard_origin", { url }).catch((e: unknown) => {
    console.warn("could not tell the shell the dashboard address", e);
  });
}
