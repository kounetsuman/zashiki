import { describe, expect, it } from "vitest";

import { fakeWebSocketFactory } from "./fake-websocket.js";
import { openTermSocket } from "./term.js";

describe("openTermSocket", () => {
  it("passes text frames through to onData as-is", () => {
    const { create, instances } = fakeWebSocketFactory();
    const received: string[] = [];
    openTermSocket("ws://test", { onData: (d) => received.push(d) }, create);
    instances[0]?.emitMessage("hello");
    expect(received).toEqual(["hello"]);
  });

  it("UTF-8 decodes binary frames and passes them to onData", () => {
    const { create, instances } = fakeWebSocketFactory();
    const received: string[] = [];
    openTermSocket("ws://test", { onData: (d) => received.push(d) }, create);
    const encoded = new TextEncoder().encode("あ");
    instances[0]?.emitMessage(encoded.buffer);
    expect(received).toEqual(["あ"]);
  });

  it("does not garble text when a multibyte sequence is split across a frame boundary", () => {
    const { create, instances } = fakeWebSocketFactory();
    const received: string[] = [];
    openTermSocket("ws://test", { onData: (d) => received.push(d) }, create);

    // UTF-8 byte sequence of "あ" (U+3042): 0xE3 0x81 0x82
    const fullBytes = new TextEncoder().encode("あ");
    // frame 1: first 2 bytes
    const frame1 = fullBytes.slice(0, 2).buffer;
    // frame 2: remaining 1 byte
    const frame2 = fullBytes.slice(2).buffer;

    instances[0]?.emitMessage(frame1);
    instances[0]?.emitMessage(frame2);

    // Non-streaming would produce ["<U+FFFD>", "<U+FFFD>"].
    // A streaming decoder produces ["", "あ"].
    expect(received.join("")).toBe("あ");
    expect(received.some((s) => s.includes("�"))).toBe(false);
  });

  it("messages do not reach onData after close()", () => {
    const { create, instances } = fakeWebSocketFactory();
    const received: string[] = [];
    const handle = openTermSocket(
      "ws://test",
      { onData: (d) => received.push(d) },
      create,
    );
    handle.close();
    instances[0]?.emitMessage("after-close");
    expect(received).toHaveLength(0);
  });

  it("a server-initiated disconnect calls onClose", () => {
    const { create, instances } = fakeWebSocketFactory();
    const codes: (number | undefined)[] = [];
    openTermSocket("ws://test", { onClose: (c) => codes.push(c) }, create);
    instances[0]?.emitClose(4404);
    expect(codes).toEqual([4404]);
  });

  it("a server disconnect after a user close() does not call onClose", () => {
    const { create, instances } = fakeWebSocketFactory();
    const codes: (number | undefined)[] = [];
    const handle = openTermSocket(
      "ws://test",
      { onClose: (c) => codes.push(c) },
      create,
    );
    handle.close();
    instances[0]?.emitClose(1000);
    expect(codes).toHaveLength(0);
  });
});
