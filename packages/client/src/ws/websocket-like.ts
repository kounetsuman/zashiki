/**
 * The common subset of the browser WebSocket and Node 22's undici WebSocket.
 * The connection layer depends only on this interface (a mock is injected in tests).
 */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** WebSocket.OPEN (avoids depending on the WebSocket global just to reference the constant). */
export const WS_OPEN = 1;

export function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}
