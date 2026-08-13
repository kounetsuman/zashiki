import {
  defaultWebSocketFactory,
  type WebSocketFactory,
  WS_OPEN,
} from "./websocket-like.js";

export interface TermSocketHandlers {
  onOpen?(): void;
  /** pty output (the server sends text frames, but binary frames are also decoded). */
  onData?(data: string): void;
  /**
   * Called only on a server-initiated disconnect (not called when close() is invoked).
   * code is the server's close code (4404 = termId not registered).
   */
  onClose?(code?: number): void;
}

export interface TermSocketHandle {
  send(data: string): boolean;
  close(): void;
}

/**
 * /ws/term/<termId> client (raw bidirectional PTY binary only).
 * Only pty input/output flows over this channel. Control such as flow-control ACKs
 * is all handled on the /ws/control side (every send on this channel is treated as pty input).
 */
export function openTermSocket(
  url: string,
  handlers: TermSocketHandlers,
  createWebSocket: WebSocketFactory = defaultWebSocketFactory,
): TermSocketHandle {
  const ws = createWebSocket(url);
  // Avoid async reads via Blob (so binary frames can be decoded synchronously)
  if (ws.binaryType !== undefined) ws.binaryType = "arraybuffer";
  let closedByUser = false;
  // Per-connection streaming decoder: even if a UTF-8 multibyte sequence is split at a
  // WS frame boundary, it is completed in the next frame, preventing mojibake from U+FFFD replacement.
  const decoder = new TextDecoder();

  ws.addEventListener("open", () => {
    if (!closedByUser) handlers.onOpen?.();
  });
  ws.addEventListener("message", (ev) => {
    if (closedByUser) return;
    const d = (ev as { data: unknown }).data;
    if (typeof d === "string") handlers.onData?.(d);
    else if (d instanceof ArrayBuffer)
      handlers.onData?.(decoder.decode(d, { stream: true }));
  });
  ws.addEventListener("close", (ev) => {
    if (!closedByUser) handlers.onClose?.((ev as { code?: number }).code);
  });
  ws.addEventListener("error", () => undefined); // close always follows

  return {
    send(data: string): boolean {
      if (ws.readyState !== WS_OPEN) return false;
      try {
        ws.send(data);
        return true;
      } catch {
        return false;
      }
    },
    close(): void {
      closedByUser = true;
      ws.close();
    },
  };
}
