/** Whether `url` is an absolute http(s) address. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Whether a link points at another site: an http(s) address, or a protocol-relative `//host` one. */
export function isWebLink(href: string): boolean {
  return isHttpUrl(href) || href.startsWith("//");
}
