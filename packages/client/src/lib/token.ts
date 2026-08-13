/**
 * Token handling (no cookies used):
 * Save the `?token=` from the initial access URL into sessionStorage and strip it from the URL.
 * Thereafter, REST sends it via the `x-zashiki-token` header and WS via the `?token=` query.
 */

export const TOKEN_STORAGE_KEY = "zk_token";

/** Minimal sessionStorage-compatible interface (for test injection). */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Resolve the token, giving priority to ?token= in the URL. If present in the URL, save it to the store
 * (overwriting the old saved value with the new token = re-entry after a server restart).
 */
export function resolveToken(search: string, store: TokenStore): string | null {
  const fromUrl = new URLSearchParams(search).get("token");
  if (fromUrl) {
    store.setItem(TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return store.getItem(TOKEN_STORAGE_KEY);
}

/** Return the search string with only the token parameter removed (for history.replaceState). */
export function stripTokenFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("token");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** Authentication header for REST. */
export function authHeaders(token: string): Record<string, string> {
  return { "x-zashiki-token": token };
}
