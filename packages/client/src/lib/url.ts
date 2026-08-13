/** Build the WS connection URL (the token is sent as a query parameter). */
export function wsUrl(httpBase: string, path: string, token: string): string {
  const base = new URL(httpBase);
  const proto = base.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${base.host}${path}?token=${encodeURIComponent(token)}`;
}

export function controlWsUrl(httpBase: string, token: string): string {
  return wsUrl(httpBase, "/ws/control", token);
}

export function termWsUrl(
  httpBase: string,
  termId: string,
  token: string,
): string {
  return wsUrl(httpBase, `/ws/term/${termId}`, token);
}
