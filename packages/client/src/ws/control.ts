import type { ClientMessage, ServerMessage } from "@zashiki/shared";

import { reconnectDelayMs } from "../lib/backoff.js";
import { decodeServerMessage, encodeClientMessage } from "../lib/protocol.js";
import {
  defaultWebSocketFactory,
  type WebSocketFactory,
  type WebSocketLike,
  WS_OPEN,
} from "./websocket-like.js";

export type ControlStatus = "connecting" | "open" | "closed";

/** Minimal control-plane interface that TerminalSession and others depend on. */
export interface ControlLike {
  getStatus(): ControlStatus;
  send(msg: ClientMessage): boolean;
  onStatus(fn: (s: ControlStatus) => void): () => void;
}

export interface ControlClientOptions {
  /** Full /ws/control URL (including ?token=). */
  url: string;
  createWebSocket?: WebSocketFactory;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * /ws/control client.
 * - Incoming messages are parsed and validated with zod; invalid messages are silently dropped.
 * - On disconnect, reconnects automatically with exponential backoff (attempt resets on open).
 * - After reconnecting, the server automatically sends state.sync, so no client-side
 *   state re-fetch message is needed.
 */
export class ControlClient implements ControlLike {
  private readonly options: ControlClientOptions;
  private ws: WebSocketLike | null = null;
  private status: ControlStatus = "closed";
  private attempt = 0;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly messageListeners = new Set<(m: ServerMessage) => void>();
  private readonly statusListeners = new Set<(s: ControlStatus) => void>();
  private lastCloseCode: number | null = null;
  private readonly tapListeners = new Set<
    (dir: "send" | "recv", t: string) => void
  >();
  // The most recent config.sync. config.sync is not resent unless it changes,
  // and it arrives only once right after connecting, so if a subscription is not
  // registered in time for open, it is missed. We retain it and immediately replay it
  // when a new onMessage is registered, so the initial sync is never lost.
  private lastConfigSync: ServerMessage | null = null;

  constructor(options: ControlClientOptions) {
    this.options = options;
  }

  getStatus(): ControlStatus {
    return this.status;
  }

  /** Diagnostic snapshot for debug mode. */
  debugSnapshot(): {
    status: ControlStatus;
    attempt: number;
    lastCloseCode: number | null;
  } {
    return {
      status: this.status,
      attempt: this.attempt,
      lastCloseCode: this.lastCloseCode,
    };
  }

  /**
   * Taps the control WS send/receive traffic (for debug protocol tailing).
   * Passes only the discriminator t, not the message body (avoids accumulating PII or large data).
   */
  onProtocol(fn: (dir: "send" | "recv", t: string) => void): () => void {
    this.tapListeners.add(fn);
    return () => this.tapListeners.delete(fn);
  }

  onMessage(fn: (m: ServerMessage) => void): () => void {
    this.messageListeners.add(fn);
    // Do not miss the initial config.sync that arrived before registration (guards against the subscribe/open race)
    if (this.lastConfigSync) fn(this.lastConfigSync);
    return () => this.messageListeners.delete(fn);
  }

  onStatus(fn: (s: ControlStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  connect(): void {
    if (this.disposed || this.ws) return;
    this.setStatus("connecting");
    const create = this.options.createWebSocket ?? defaultWebSocketFactory;
    const ws = create(this.options.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (ws !== this.ws) return;
      this.attempt = 0;
      this.setStatus("open");
    });
    ws.addEventListener("message", (ev) => {
      if (ws !== this.ws) return;
      const msg = decodeServerMessage((ev as { data: unknown }).data);
      if (!msg) return; // drop invalid messages (keep the connection alive)
      // Retain the latest config.sync and replay it to future onMessage registrations (prevents missing the initial sync)
      if (msg.t === "config.sync") this.lastConfigSync = msg;
      for (const fn of this.tapListeners) fn("recv", msg.t);
      for (const fn of this.messageListeners) fn(msg);
    });
    ws.addEventListener("close", (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.lastCloseCode = (ev as { code?: number }).code ?? null;
      this.setStatus("closed");
      this.scheduleReconnect();
    });
    // error is always followed by close, so it is handled on the close side
    ws.addEventListener("error", () => undefined);
  }

  /** Sends only when in the open state; otherwise returns false (the caller decides whether to resend). */
  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    try {
      this.ws.send(encodeClientMessage(msg));
      for (const fn of this.tapListeners) fn("send", msg.t);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus("closed");
  }

  private setStatus(s: ControlStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = reconnectDelayMs(
      this.attempt,
      this.options.baseDelayMs,
      this.options.maxDelayMs,
    );
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
