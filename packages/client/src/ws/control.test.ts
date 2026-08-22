import type { ServerMessage } from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControlClient } from "./control.js";
import { fakeWebSocketFactory } from "./fake-websocket.js";

describe("ControlClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const factory = fakeWebSocketFactory();
    const client = new ControlClient({
      url: "ws://127.0.0.1:8790/ws/control?token=t",
      createWebSocket: factory.create,
    });
    const messages: ServerMessage[] = [];
    const statuses: string[] = [];
    client.onMessage((m) => messages.push(m));
    client.onStatus((s) => statuses.push(s));
    return { factory, client, messages, statuses };
  }

  it("status becomes open on connect -> open and only valid messages are delivered", () => {
    const { factory, client, messages, statuses } = setup();
    client.connect();
    expect(factory.instances).toHaveLength(1);
    const ws = factory.instances[0];
    if (!ws) throw new Error("ws missing");
    ws.emitOpen();
    expect(client.getStatus()).toBe("open");

    ws.emitMessage(
      JSON.stringify({
        t: "state.sync",
        cockpitTerminals: [],
        orgs: [],
        orgColors: {},
      }),
    );
    ws.emitMessage("broken{{{"); // invalid JSON is ignored
    ws.emitMessage(JSON.stringify({ t: "unknown-type" })); // schema violations are ignored
    expect(messages).toEqual([
      {
        t: "state.sync",
        cockpitTerminals: [],
        orgs: [],
        orgColors: {},
        orgAliases: {},
      },
    ]);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("send sends schema-validated JSON; returns false when not connected", () => {
    const { factory, client } = setup();
    expect(client.send({ t: "term.close", termId: "abc" })).toBe(false);
    client.connect();
    const ws = factory.instances[0];
    if (!ws) throw new Error("ws missing");
    expect(client.send({ t: "term.close", termId: "abc" })).toBe(false);
    ws.emitOpen();
    expect(client.send({ t: "term.close", termId: "abc" })).toBe(true);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { t: "term.close", termId: "abc" },
    ]);
  });

  it("reconnects with exponential backoff on disconnect, and attempt resets on open", () => {
    const { factory, client } = setup();
    client.connect();
    factory.instances[0]?.emitOpen();
    factory.instances[0]?.emitClose();
    expect(client.getStatus()).toBe("closed");

    // 1st attempt: reconnect after 500ms
    vi.advanceTimersByTime(499);
    expect(factory.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(factory.instances).toHaveLength(2);

    // connection failure (close before open) -> 2nd attempt after 1000ms
    factory.instances[1]?.emitClose();
    vi.advanceTimersByTime(999);
    expect(factory.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(factory.instances).toHaveLength(3);

    // opening resets attempt -> the next disconnect is 500ms again
    factory.instances[2]?.emitOpen();
    factory.instances[2]?.emitClose();
    vi.advanceTimersByTime(500);
    expect(factory.instances).toHaveLength(4);
  });

  it("debugSnapshot returns status/attempt/lastCloseCode", () => {
    const { factory, client } = setup();
    expect(client.debugSnapshot()).toEqual({
      status: "closed",
      attempt: 0,
      lastCloseCode: null,
    });
    client.connect();
    factory.instances[0]?.emitOpen();
    expect(client.debugSnapshot()).toEqual({
      status: "open",
      attempt: 0,
      lastCloseCode: null,
    });
    // server-initiated disconnect -> record close code and increment attempt
    factory.instances[0]?.emitClose(1006);
    const snap = client.debugSnapshot();
    expect(snap.status).toBe("closed");
    expect(snap.lastCloseCode).toBe(1006);
    expect(snap.attempt).toBe(1);
  });

  it("onProtocol taps the send/receive direction and the discriminator t", () => {
    const { factory, client } = setup();
    const tapped: string[] = [];
    client.onProtocol((dir, t) => tapped.push(`${dir}:${t}`));
    client.connect();
    const ws = factory.instances[0];
    if (!ws) throw new Error("ws missing");
    ws.emitOpen();
    client.send({ t: "term.close", termId: "abc" });
    ws.emitMessage(
      JSON.stringify({
        t: "state.sync",
        cockpitTerminals: [],
        orgs: [],
        orgColors: {},
      }),
    );
    ws.emitMessage("broken{{{"); // invalid messages are not tapped
    expect(tapped).toEqual(["send:term.close", "recv:state.sync"]);
  });

  it("does not reconnect after dispose", () => {
    const { factory, client } = setup();
    client.connect();
    factory.instances[0]?.emitOpen();
    client.dispose();
    expect(factory.instances[0]?.closeCalls).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(factory.instances).toHaveLength(1);
  });

  it("a config.sync that arrives before subscription is replayed to a later-registered onMessage (prevents missing the initial sync)", () => {
    const factory = fakeWebSocketFactory();
    const client = new ControlClient({
      url: "ws://127.0.0.1:8790/ws/control?token=t",
      createWebSocket: factory.create,
    });
    client.connect();
    const ws = factory.instances[0];
    if (!ws) throw new Error("ws missing");
    ws.emitOpen();
    // config.sync arrives while there are zero subscribers (reproducing the open race)
    ws.emitMessage(JSON.stringify({ t: "config.sync", notifySound: false }));
    // subscribing later still receives the most recent config.sync
    const late: ServerMessage[] = [];
    client.onMessage((m) => late.push(m));
    expect(late).toEqual([
      {
        t: "config.sync",
        notifySound: false,
        updateCheck: true,
        language: null,
        accountUsage: false,
        editor: null,
      },
    ]);
  });

  it("config.sync replays only the most recent one (replays the new value after an update)", () => {
    const factory = fakeWebSocketFactory();
    const client = new ControlClient({
      url: "ws://127.0.0.1:8790/ws/control?token=t",
      createWebSocket: factory.create,
    });
    client.connect();
    const ws = factory.instances[0];
    if (!ws) throw new Error("ws missing");
    ws.emitOpen();
    ws.emitMessage(JSON.stringify({ t: "config.sync", notifySound: true }));
    ws.emitMessage(JSON.stringify({ t: "config.sync", notifySound: false }));
    const late: ServerMessage[] = [];
    client.onMessage((m) => late.push(m));
    expect(late).toEqual([
      {
        t: "config.sync",
        notifySound: false,
        updateCheck: true,
        language: null,
        accountUsage: false,
        editor: null,
      },
    ]);
  });
});
