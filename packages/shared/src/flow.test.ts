import { describe, expect, it } from "vitest";

import {
  type FlowState,
  initialFlowState,
  onBytesAcked,
  onBytesSent,
  tallyWrittenBytes,
} from "./flow.js";

const w = { high: 100, low: 30 };

describe("onBytesSent / onBytesAcked (server-side watermark decisions)", () => {
  it("does not pause at or below the high watermark", () => {
    let s: FlowState = initialFlowState;
    s = onBytesSent(s, 50, w);
    expect(s).toEqual({ unacked: 50, paused: false });
    s = onBytesSent(s, 50, w); // exactly high does not pause yet
    expect(s).toEqual({ unacked: 100, paused: false });
  });

  it("pauses when the high watermark is exceeded", () => {
    let s: FlowState = initialFlowState;
    s = onBytesSent(s, 101, w);
    expect(s.paused).toBe(true);
  });

  it("while paused, does not resume until ACKs drain down to the low watermark", () => {
    let s: FlowState = onBytesSent(initialFlowState, 150, w);
    expect(s.paused).toBe(true);
    s = onBytesAcked(s, 50, w); // unacked=100 > low=30 -> still paused
    expect(s).toEqual({ unacked: 100, paused: true });
    s = onBytesAcked(s, 70, w); // unacked=30 <= low -> resume
    expect(s).toEqual({ unacked: 30, paused: false });
  });

  it("re-pauses when a send after resume exceeds the high watermark again (hysteresis)", () => {
    let s: FlowState = onBytesSent(initialFlowState, 150, w);
    s = onBytesAcked(s, 150, w);
    expect(s).toEqual({ unacked: 0, paused: false });
    s = onBytesSent(s, 101, w);
    expect(s.paused).toBe(true);
  });

  it("unacked never goes below 0 even with excess ACKs", () => {
    const s = onBytesAcked(onBytesSent(initialFlowState, 10, w), 9999, w);
    expect(s.unacked).toBe(0);
  });

  it("an ACK while not paused does not worsen the state", () => {
    const s = onBytesAcked(onBytesSent(initialFlowState, 50, w), 20, w);
    expect(s).toEqual({ unacked: 30, paused: false });
  });
});

describe("tallyWrittenBytes (client-side ACK accumulation)", () => {
  it("only accumulates below the threshold", () => {
    expect(tallyWrittenBytes(0, 10, 64)).toEqual({ pending: 10, ackBytes: 0 });
    expect(tallyWrittenBytes(10, 20, 64)).toEqual({ pending: 30, ackBytes: 0 });
  });

  it("returns the whole accumulated amount as an ACK and resets when the threshold is reached", () => {
    expect(tallyWrittenBytes(60, 10, 64)).toEqual({ pending: 0, ackBytes: 70 });
    expect(tallyWrittenBytes(0, 64, 64)).toEqual({ pending: 0, ackBytes: 64 });
  });

  it("ACKs immediately even for a single huge chunk", () => {
    expect(tallyWrittenBytes(0, 1_000_000, 64)).toEqual({
      pending: 0,
      ackBytes: 1_000_000,
    });
  });
});
