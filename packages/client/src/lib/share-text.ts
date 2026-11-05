import { invoke, isTauri } from "@tauri-apps/api/core";

export function canShareText(): boolean {
  return isTauri();
}

/** Opens the macOS share sheet for `text`, pointing at `anchor` (no-op outside Tauri). */
export async function shareText(text: string, anchor: DOMRect): Promise<void> {
  if (!isTauri()) return;
  const { x, y, width, height } = anchor;
  await invoke("share_text", { text, anchor: { x, y, width, height } }).catch(
    () => undefined,
  );
}
