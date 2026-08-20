import { tallyWrittenBytes } from "@zashiki/shared";

import { reconnectDelayMs } from "../lib/backoff.js";
import type { ControlLike } from "../ws/control.js";
import type { TermSocketHandle, TermSocketHandlers } from "../ws/term.js";

export type TermAttachStatus =
  | "idle"
  | "waiting-control"
  | "opening"
  | "attached"
  | "reconnecting"
  | "disposed";

export interface TerminalSessionOptions {
  control: ControlLike;
  /** Opens /ws/term/<termId> (backed by openTermSocket + URL assembly in ws/term.ts). */
  openTermSocket(
    termId: string,
    handlers: TermSocketHandlers,
  ): TermSocketHandle;
  generateTermId?(): string;
  /** Accumulate this many written chars from xterm.js before sending term.ack. */
  ackThresholdChars?: number;
  retryDelayMs?(attempt: number): number;
}

const DEFAULT_ACK_THRESHOLD = 64 * 1024;
/**
 * Maximum number of re-attaches of the same termId on 4404 (server still
 * processing term.open). If term.open itself failed (e.g. work_not_found), the
 * entry will never be created, so once the limit is exceeded we start over with
 * a new termId + term.open.
 */
const MAX_SAME_TERM_REATTACHES = 4;

/**
 * Connection orchestration for a single terminal view (1 view = 1 termId =
 * 1 /ws/term connection = 1 zk-* session).
 *
 * - term.open (control) -> /ws/term connection -> initial term.ack(0) enables ACK-based flow control
 * - On a server-initiated disconnect, reopen with a "new termId" after backoff
 *   (the old termId's server-side registration is cleaned up on disconnect
 *   detection; reusing the same ID is avoided because it hits the term_exists
 *   race). The visible window is preserved by carrying the cockpitTerminalId over in
 *   term.open.
 * - ACKs accumulated while control is down are re-queued and flushed when control recovers
 */
export class TerminalSession {
  private readonly options: TerminalSessionOptions;
  private readonly offControlStatus: () => void;
  private status: TermAttachStatus = "idle";
  private cols = 80;
  private rows = 24;
  /** The cols/rows sent in the most recent term.open. Used to decide whether resize must be re-sent on attach. */
  private openedCols = 80;
  private openedRows = 24;
  private cockpitTerminalId: string | null = null;
  private termId: string | null = null;
  private socket: TermSocketHandle | null = null;
  private pendingAck = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /** State where no terminal is attached because there are 0 cockpit terminals (suppresses respawn). */
  private suspended = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly statusListeners = new Set<(s: TermAttachStatus) => void>();

  constructor(options: TerminalSessionOptions) {
    this.options = options;
    this.offControlStatus = options.control.onStatus((s) => {
      if (s !== "open" || this.status === "disposed") return;
      if (this.status === "waiting-control") {
        this.tryOpen();
      } else if (this.status === "attached" && this.pendingAck > 0) {
        // Flush ACKs accumulated while control was down (releases the server-side pause)
        this.flushAck(0);
      }
    });
  }

  getStatus(): TermAttachStatus {
    return this.status;
  }

  getTermId(): string | null {
    return this.termId;
  }

  /** Diagnostic snapshot for debug mode. */
  debugSnapshot(): {
    status: TermAttachStatus;
    attempt: number;
    pendingAck: number;
    cockpitTerminalId: string | null;
    termId: string | null;
    suspended: boolean;
  } {
    return {
      status: this.status,
      attempt: this.attempt,
      pendingAck: this.pendingAck,
      cockpitTerminalId: this.cockpitTerminalId,
      termId: this.termId,
      suspended: this.suspended,
    };
  }

  onData(fn: (data: string) => void): () => void {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  onStatus(fn: (s: TermAttachStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  start(cols: number, rows: number): void {
    if (this.started || this.status === "disposed") return;
    this.started = true;
    this.cols = cols;
    this.rows = rows;
    if (this.suspended) return;
    this.tryOpen();
  }

  /**
   * When cockpit terminals drop to 0, release the terminal and stop reconnecting.
   * Prevents a reconnect right after killing a work from spawning a bare new
   * work. The visible window is gone, so forget it; on resume, re-attach to the
   * work's active window.
   */
  suspend(): void {
    if (this.status === "disposed" || this.suspended) return;
    this.suspended = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.termId) {
      this.options.control.send({ t: "term.close", termId: this.termId });
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.termId = null;
    this.cockpitTerminalId = null;
    this.pendingAck = 0;
    this.attempt = 0;
    this.setStatus("idle");
  }

  /** Re-attach the terminal when the session is revived (only if suspended). */
  resume(): void {
    if (this.status === "disposed" || !this.suspended) return;
    this.suspended = false;
    if (this.started) this.tryOpen();
  }

  /** Input to the pty (keystrokes). */
  input(data: string): void {
    this.socket?.send(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.termId && this.status === "attached") {
      this.options.control.send({
        t: "term.resize",
        termId: this.termId,
        cols,
        rows,
      });
    }
  }

  /** Window switch. Carried over via cockpitTerminalId across reconnects too. */
  select(cockpitTerminalId: string): void {
    this.cockpitTerminalId = cockpitTerminalId;
    if (this.termId && this.status === "attached") {
      this.options.control.send({
        t: "term.select",
        termId: this.termId,
        cockpitTerminalId,
      });
    }
  }

  /** Called from xterm.js's write-completion callback (chars = number of chars written). */
  notifyWritten(chars: number): void {
    this.flushAck(chars);
  }

  /**
   * Server-initiated re-attach instruction (term.reconnect, e.g. after restore).
   * Discards the old connection and immediately reopens with a new termId + the
   * currently visible cockpitTerminalId.
   */
  reconnect(): void {
    if (this.status === "disposed" || !this.started) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.attempt = 0;
    this.tryOpen();
  }

  dispose(): void {
    if (this.status === "disposed") return;
    this.offControlStatus();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.termId) {
      this.options.control.send({ t: "term.close", termId: this.termId });
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setStatus("disposed");
  }

  private setStatus(s: TermAttachStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private tryOpen(): void {
    if (this.status === "disposed" || this.suspended) return;
    if (this.options.control.getStatus() !== "open") {
      this.setStatus("waiting-control");
      return;
    }
    const termId = (
      this.options.generateTermId ?? (() => crypto.randomUUID())
    )();
    this.termId = termId;
    this.pendingAck = 0;
    this.openedCols = this.cols;
    this.openedRows = this.rows;
    this.setStatus("opening");
    const sent = this.options.control.send({
      t: "term.open",
      termId,
      ...(this.cockpitTerminalId !== null
        ? { cockpitTerminalId: this.cockpitTerminalId }
        : {}),
      cols: this.cols,
      rows: this.rows,
    });
    if (!sent) {
      this.setStatus("waiting-control");
      return;
    }
    this.connectSocket(termId);
  }

  private connectSocket(termId: string): void {
    this.socket = this.options.openTermSocket(termId, {
      onOpen: () => {
        if (this.status === "disposed" || this.termId !== termId) return;
        // Don't reset attempt here: a successful handshake happens before termId
        // verification, so it's not proof of success (reset it in onData instead).
        this.setStatus("attached");
        // The initial ACK with bytes=0 enables ACK-based flow control
        this.options.control.send({ t: "term.ack", termId, bytes: 0 });
        // Reflect cols/rows that changed before attach (during opening). If the
        // initial fit ran with cells undetermined and term.open was sent with an
        // undersized value, a subsequent onRender re-fit that runs before attach
        // has its term.resize swallowed, so re-send it on attach (to match the
        // pty=tmux window to the actual render width). Skip the send if it equals
        // what term.open already carried.
        if (this.cols !== this.openedCols || this.rows !== this.openedRows) {
          this.options.control.send({
            t: "term.resize",
            termId,
            cols: this.cols,
            rows: this.rows,
          });
        }
        // Reflect the window selected before attach (during opening)
        // (select-window is idempotent even if it was included in term.open)
        if (this.cockpitTerminalId !== null) {
          this.options.control.send({
            t: "term.select",
            termId,
            cockpitTerminalId: this.cockpitTerminalId,
          });
        }
      },
      onData: (data) => {
        if (this.termId !== termId) return;
        this.attempt = 0;
        for (const fn of this.dataListeners) fn(data);
      },
      onClose: (code) => {
        if (this.status === "disposed" || this.termId !== termId) return;
        this.socket = null;
        // 4404 just means the server hasn't processed term.open yet (the WS
        // handshake succeeds before termId verification). Re-sending term.open
        // would cause term_exists, so re-attach only the WS with the same termId
        // (with a limit).
        const reattach =
          code === 4404 && this.attempt < MAX_SAME_TERM_REATTACHES;
        // When tmux leaves the alternate screen, the old display (initial screen,
        // etc.) lingers. Clear the visible screen so it isn't shown while waiting
        // to reconnect. For an immediate 4404 re-attach, tmux is still alive, so
        // keep the display valid.
        if (!reattach) {
          for (const fn of this.dataListeners) fn("\x1b[H\x1b[2J");
        }
        this.scheduleRetry(reattach ? termId : null);
      },
    });
  }

  private scheduleRetry(reattachTermId: string | null): void {
    if (this.retryTimer || this.status === "disposed" || this.suspended) return;
    this.setStatus("reconnecting");
    const delayFn = this.options.retryDelayMs ?? reconnectDelayMs;
    const delay = delayFn(this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (reattachTermId !== null && this.termId === reattachTermId) {
        this.connectSocket(reattachTermId);
      } else {
        this.tryOpen();
      }
    }, delay);
  }

  /** Update and send the accumulated ACK. Re-queue whatever couldn't be sent. */
  private flushAck(chars: number): void {
    if (this.status === "disposed" || this.termId === null) return;
    const threshold = this.options.ackThresholdChars ?? DEFAULT_ACK_THRESHOLD;
    const { pending, ackBytes } = tallyWrittenBytes(
      this.pendingAck,
      chars,
      threshold,
    );
    this.pendingAck = pending;
    if (ackBytes > 0) {
      const sent = this.options.control.send({
        t: "term.ack",
        termId: this.termId,
        bytes: ackBytes,
      });
      if (!sent) this.pendingAck += ackBytes;
    }
  }
}
