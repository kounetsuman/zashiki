const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const NETWORK_PATH = /^[/\\]{2}/;
const INERT_SCHEMES = new Set(["data", "blob"]);
const NETWORK_PATH_BASE = "https://placeholder.invalid/";

/** The URL parser drops these before reading a URL, so the browser does too. */
function asTheBrowserReadsIt(src: string): string {
  const withoutBreaks = src.replace(/[\t\n\r]/g, "");
  let start = 0;
  while (
    start < withoutBreaks.length &&
    withoutBreaks.charCodeAt(start) <= 0x20
  )
    start++;
  return withoutBreaks.slice(start);
}

/**
 * The host an image source would be fetched from when it lies outside the repo (the source
 * itself, shortened, when it has no host), or null for a repo path or an inline (`data:` /
 * `blob:`) image. Any explicit scheme or a `//` / `/\` prefix
 * counts as outside the repo.
 */
export function remoteImageHost(src: string): string | null {
  const read = asTheBrowserReadsIt(src);
  const scheme = EXPLICIT_SCHEME.exec(read)?.[1]?.toLowerCase();
  if (scheme === undefined && !NETWORK_PATH.test(read)) return null;
  if (scheme !== undefined && INERT_SCHEMES.has(scheme)) return null;
  try {
    const url =
      scheme === undefined ? new URL(read, NETWORK_PATH_BASE) : new URL(read);
    if (url.host !== "") return url.host;
  } catch {}
  return shortened(src);
}

const MAX_LABEL_LENGTH = 60;

function shortened(text: string): string {
  return text.length <= MAX_LABEL_LENGTH
    ? text
    : `${text.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}
