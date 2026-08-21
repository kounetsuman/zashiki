import { invoke, isTauri } from "@tauri-apps/api/core";

/** Whether the app runs inside the Tauri shell, where the WebView inspector can be opened. */
export function canOpenDevtools(): boolean {
  return isTauri();
}

/** Opens the WebView inspector via the Tauri shell command (no-op outside Tauri). */
export async function openDevtools(): Promise<void> {
  if (!isTauri()) return;
  await invoke("open_devtools").catch(() => undefined);
}
