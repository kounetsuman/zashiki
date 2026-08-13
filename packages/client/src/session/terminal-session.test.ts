import type { ClientMessage } from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ControlLike, ControlStatus } from "../ws/control.js";
import type { TermSocketHandle, TermSocketHandlers } from "../ws/term.js";
import { TerminalSession } from "./terminal-session.js";

class FakeControl implements ControlLike {
  status: ControlStatus = "open";
  sendResult = true;
  readonly sent: ClientMessage[] = [];
  private readonly statusListeners = new Set<(s: ControlStatus) => void>();

  getStatus(): ControlStatus {
    return this.status;
  }

  send(msg: ClientMessage): boolean {
    if (!this.sendResult) return false;
    this.sent.push(msg);
    return true;
  }

  onStatus(fn: (s: ControlStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  setStatus(s: ControlStatus): void {
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }
}

interface FakeTermSocket {
  termId: string;
  handlers: TermSocketHandlers;
  handle: TermSocketHandle & { sent: string[]; closed: boolean };
}

function setup(opts: { ackThresholdChars?: number } = {}) {
  const control = new FakeControl();
  const sockets: FakeTermSocket[] = [];
  let seq = 0;
  const session = new TerminalSession({
    control,
    openTermSocket: (termId, handlers) => {
      const sent: string[] = [];
      const handle = {
        sent,
        closed: false,
        send: (data: string) => {
          sent.push(data);
          return true;
        },
        close(): void {
          handle.closed = true;
        },
      };
      sockets.push({ termId, handlers, handle });
      return handle;
    },
    generateTermId: () => `term-${++seq}`,
    ackThresholdChars: opts.ackThresholdChars ?? 100,
  });
  return { control, sockets, session };
}

function sentOfType<T extends ClientMessage["t"]>(
  control: FakeControl,
  t: T,
): Extract<ClientMessage, { t: T }>[] {
  return control.sent.filter((m) => m.t === t) as Extract<
    ClientMessage,
    { t: T }
  >[];
}

describe("TerminalSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends term.open on start, and on socket open becomes attached with an initial ACK(0)", () => {
    const { control, sockets, session } = setup();
    session.start(120, 40);
    expect(control.sent).toEqual([
      { t: "term.open", termId: "term-1", cols: 120, rows: 40 },
    ]);
    expect(sockets).toHaveLength(1);
    expect(session.getStatus()).toBe("opening");

    sockets[0]?.handlers.onOpen?.();
    expect(session.getStatus()).toBe("attached");
    expect(sentOfType(control, "term.ack")).toEqual([
      { t: "term.ack", termId: "term-1", bytes: 0 },
    ]);
  });

  it("waits while control is disconnected and opens once it becomes open", () => {
    const { control, sockets, session } = setup();
    control.status = "closed";
    session.start(80, 24);
    expect(session.getStatus()).toBe("waiting-control");
    expect(sockets).toHaveLength(0);

    control.setStatus("open");
    expect(sockets).toHaveLength(1);
    expect(sentOfType(control, "term.open")).toHaveLength(1);
  });

  it("delivers pty data to onData subscribers and forwards input to the socket", () => {
    const { sockets, session } = setup();
    const received: string[] = [];
    session.onData((d) => received.push(d));
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();

    sockets[0]?.handlers.onData?.("hello");
    expect(received).toEqual(["hello"]);

    session.input("ls\r");
    expect(sockets[0]?.handle.sent).toEqual(["ls\r"]);
  });

  it("notifyWritten batches ACKs and sends them at the threshold", () => {
    const { control, sockets, session } = setup({ ackThresholdChars: 100 });
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    control.sent.length = 0;

    session.notifyWritten(60);
    expect(sentOfType(control, "term.ack")).toHaveLength(0);
    session.notifyWritten(50); // total 110 >= 100
    expect(sentOfType(control, "term.ack")).toEqual([
      { t: "term.ack", termId: "term-1", bytes: 110 },
    ]);
  });

  it("re-accumulates ACKs while control is down and flushes them when control recovers", () => {
    const { control, sockets, session } = setup({ ackThresholdChars: 100 });
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    control.sent.length = 0;

    control.sendResult = false; // control WS down
    session.notifyWritten(150);
    expect(sentOfType(control, "term.ack")).toHaveLength(0);

    control.sendResult = true;
    control.setStatus("open"); // reconnect complete
    expect(sentOfType(control, "term.ack")).toEqual([
      { t: "term.ack", termId: "term-1", bytes: 150 },
    ]);
  });

  it("select remembers the window and carries it over to term.open on reconnect", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    session.select("@5");
    expect(sentOfType(control, "term.select")).toEqual([
      { t: "term.select", termId: "term-1", windowId: "@5" },
    ]);

    // Server-initiated disconnect -> reopen with a new termId after backoff
    sockets[0]?.handlers.onClose?.();
    expect(session.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.termId).toBe("term-2");
    const opens = sentOfType(control, "term.open");
    expect(opens[1]).toEqual({
      t: "term.open",
      termId: "term-2",
      windowId: "@5",
      cols: 80,
      rows: 24,
    });
  });

  it("resize remembers the dimensions, sends term.resize, and reflects them on reopen", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    // On attach it equals term.open (80x24), so resize isn't sent (avoids a wasteful send).
    session.resize(200, 50);
    expect(sentOfType(control, "term.resize")).toEqual([
      { t: "term.resize", termId: "term-1", cols: 200, rows: 50 },
    ]);

    sockets[0]?.handlers.onClose?.();
    vi.advanceTimersByTime(500);
    const opens = sentOfType(control, "term.open");
    expect(opens[1]?.cols).toBe(200);
    expect(opens[1]?.rows).toBe(50);
  });

  it("resends the current cols/rows via term.resize on attach completion (recovers a swallowed onRender re-fit)", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    // Simulates a resize from an onRender re-fit arriving during opening (before
    // attach) -> it's swallowed, but this.cols/rows are updated.
    session.resize(143, 40);
    expect(sentOfType(control, "term.resize")).toHaveLength(0);

    sockets[0]?.handlers.onOpen?.();
    expect(sentOfType(control, "term.resize")).toEqual([
      { t: "term.resize", termId: "term-1", cols: 143, rows: 40 },
    ]);
  });

  it("on a 4404 disconnect (server still processing term.open), reopens only the WS with the same termId", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);

    // The handshake succeeds before termId verification -> closed with 4404 right after open
    sockets[0]?.handlers.onOpen?.();
    sockets[0]?.handlers.onClose?.(4404);
    expect(session.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(500);

    // term.open is not re-sent (a double open of the same termId causes term_exists)
    expect(sentOfType(control, "term.open")).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.termId).toBe("term-1");

    sockets[1]?.handlers.onOpen?.();
    expect(session.getStatus()).toBe("attached");
  });

  it("keeps growing the attempt while 4404 persists, and only resets it once data is received", () => {
    const { sockets, session } = setup();
    session.start(80, 24);

    sockets[0]?.handlers.onOpen?.();
    sockets[0]?.handlers.onClose?.(4404);
    vi.advanceTimersByTime(500); // attempt 0 -> 500ms
    sockets[1]?.handlers.onOpen?.();
    sockets[1]?.handlers.onClose?.(4404);
    vi.advanceTimersByTime(999); // attempt 1 -> 1000ms (open does not reset it)
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    sockets[2]?.handlers.onOpen?.();
    sockets[2]?.handlers.onData?.("output"); // real data resets attempt
    sockets[2]?.handlers.onClose?.(4404);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(4);
  });

  it("gives up re-attaching after persistent 4404 and restarts from term.open with a new termId", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);

    // If term.open failed on the server side (e.g. work_not_found),
    // re-attaching the same termId stays 4404 forever -> switch to a full reopen at the limit
    for (let i = 0; i < 5; i++) {
      sockets[i]?.handlers.onOpen?.();
      sockets[i]?.handlers.onClose?.(4404);
      vi.advanceTimersByTime(10_000);
    }
    expect(sockets).toHaveLength(6);
    expect(sockets[5]?.termId).toBe("term-2");
    expect(sentOfType(control, "term.open")).toHaveLength(2);
  });

  it("a window selected before attach is sent via term.select on attach completion", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    session.select("@7"); // still opening (before socket open)
    expect(sentOfType(control, "term.select")).toHaveLength(0);

    sockets[0]?.handlers.onOpen?.();
    expect(sentOfType(control, "term.select")).toEqual([
      { t: "term.select", termId: "term-1", windowId: "@7" },
    ]);
  });

  it("on a non-4404 disconnect, emits the visible-screen clear sequence to onData", () => {
    const { sockets, session } = setup();
    const received: string[] = [];
    session.onData((d) => received.push(d));
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    received.length = 0; // reset data from around attach

    sockets[0]?.handlers.onClose?.(1011); // non-4404 disconnect
    expect(received).toEqual(["\x1b[H\x1b[2J"]);
  });

  it("does not emit the clear sequence on a 4404 disconnect (tmux is still alive)", () => {
    const { sockets, session } = setup();
    const received: string[] = [];
    session.onData((d) => received.push(d));
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    received.length = 0;

    sockets[0]?.handlers.onClose?.(4404);
    expect(received).toHaveLength(0);
  });

  it("dispose sends term.close, closes the socket, and never reconnects afterward", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    session.dispose();
    expect(sentOfType(control, "term.close")).toEqual([
      { t: "term.close", termId: "term-1" },
    ]);
    expect(sockets[0]?.handle.closed).toBe(true);
    expect(session.getStatus()).toBe("disposed");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("TerminalSession.suspend / resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suspend sends term.close, closes the socket, and never respawns afterward", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();

    session.suspend();
    expect(sentOfType(control, "term.close")).toEqual([
      { t: "term.close", termId: "term-1" },
    ]);
    expect(sockets[0]?.handle.closed).toBe(true);
    // A disconnect-driven reconnect must not run either
    sockets[0]?.handlers.onClose?.(1011);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("suspending while awaiting reconnect discards the timer and does not reopen", () => {
    const { sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    sockets[0]?.handlers.onClose?.(1011); // work gone -> waiting for backoff
    expect(session.getStatus()).toBe("reconnecting");

    session.suspend();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1); // does not respawn
  });

  it("resume reopens with a new termId and does not carry over a vanished displayed window", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    session.select("@5");
    session.suspend();
    control.sent.length = 0;

    session.resume();
    expect(sockets).toHaveLength(2);
    const opens = sentOfType(control, "term.open");
    expect(opens).toEqual([
      { t: "term.open", termId: "term-2", cols: 80, rows: 24 },
    ]);
  });

  it("resume without a prior suspend and a double suspend are no-ops", () => {
    const { sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();

    session.resume(); // not suspended -> no-op
    expect(sockets).toHaveLength(1);

    session.suspend();
    session.suspend(); // double -> no-op
    session.resume();
    session.resume(); // double resume -> opens only once
    expect(sockets).toHaveLength(2);
  });
});

describe("TerminalSession.reconnect (term.reconnect)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the old socket and reopens with a new termId plus the currently displayed windowId", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    session.select("@5");
    control.sent.length = 0;

    session.reconnect();
    expect(sockets[0]?.handle.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    const opens = sentOfType(control, "term.open");
    expect(opens).toEqual([
      { t: "term.open", termId: "term-2", windowId: "@5", cols: 80, rows: 24 },
    ]);
    expect(session.getStatus()).toBe("opening");

    sockets[1]?.handlers.onOpen?.();
    expect(session.getStatus()).toBe("attached");
  });

  it("is a no-op before start and after dispose", () => {
    const { sockets, session } = setup();
    session.reconnect();
    expect(sockets).toHaveLength(0);

    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    session.dispose();
    session.reconnect();
    expect(sockets).toHaveLength(1);
    expect(session.getStatus()).toBe("disposed");
  });

  it("reconnect while awaiting reconnect (retryTimer) discards the wait and reopens immediately", () => {
    const { control, sockets, session } = setup();
    session.start(80, 24);
    sockets[0]?.handlers.onOpen?.();
    sockets[0]?.handlers.onClose?.(1011); // server-initiated disconnect -> waiting for backoff
    expect(session.getStatus()).toBe("reconnecting");

    session.reconnect();
    expect(sentOfType(control, "term.open")).toHaveLength(2);
    // A discarded timer firing must not open a second time
    vi.advanceTimersByTime(60_000);
    expect(sentOfType(control, "term.open")).toHaveLength(2);
  });
});
