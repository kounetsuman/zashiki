import { invoke } from "@tauri-apps/api/core";

import { isHttpUrl } from "./web-url.js";

/**
 * The address a click should hand to the default browser: a main-button click on a web link that
 * opens a new window. Null for anything else, including a button inside the link, whose click is
 * the button's own.
 */
export function browserLinkOf(event: MouseEvent): string | null {
  if (event.button !== 0 || !(event.target instanceof Element)) return null;
  const link = event.target.closest("a[href], button");
  if (!(link instanceof HTMLAnchorElement) || link.target !== "_blank") {
    return null;
  }
  return isHttpUrl(link.href) ? link.href : null;
}

/** Asks the desktop shell to open `url` in the default browser; a refusal is reported and dropped. */
export async function openInBrowser(url: string): Promise<void> {
  await invoke("open_in_browser", { url }).catch((e: unknown) => {
    console.warn("could not open the link in the browser", e);
  });
}
