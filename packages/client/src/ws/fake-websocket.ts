import type { WebSocketLike } from "./websocket-like.js";

/**
 * WebSocket mock for tests (the connection layer is verified with a mock WS).
 * Server-side events are injected via emitOpen/emitMessage/emitClose.
 */
export class FakeWebSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  private emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }

  /** Server-initiated disconnect (no client close() call). */
  emitClose(code?: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", code === undefined ? {} : { code });
  }
}

/** Factory for FakeWebSocket that also records the created instances. */
export function fakeWebSocketFactory(): {
  create: (url: string) => WebSocketLike;
  instances: FakeWebSocket[];
} {
  const instances: FakeWebSocket[] = [];
  return {
    create: (url: string) => {
      const ws = new FakeWebSocket(url);
      instances.push(ws);
      return ws;
    },
    instances,
  };
}
