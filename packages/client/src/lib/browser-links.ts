import { invoke } from "@tauri-apps/api/core";

/**
 * The address a click should hand to the default browser: a plain click on a web link that opens a
 * new window. Null for anything else, and for a click a handler has already taken.
 */
export function browserLinkOf(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (!(event.target instanceof Element)) return null;
  const link = event.target.closest("a[href]");
  if (!(link instanceof HTMLAnchorElement) || link.target !== "_blank") {
    return null;
  }
  return link.protocol === "http:" || link.protocol === "https:"
    ? link.href
    : null;
}

/** Asks the desktop shell to open `url` in the default browser; a refusal is reported and dropped. */
export async function openInBrowser(url: string): Promise<void> {
  await invoke("open_in_browser", { url }).catch((e: unknown) => {
    console.warn("could not open the link in the browser", e);
  });
}
