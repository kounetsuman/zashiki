/**
 * Pure functions for client-side flow control (watermark scheme).
 *
 * For the server->client pty stream, the client (xterm.js) reports its completed writes
 * via `term.ack`; the server pauses the pty when the unacked amount exceeds the high watermark
 * and resumes it once it drains below the low watermark (a mechanism to avoid OOM from rendering backpressure).
 *
 * The unit of measurement is "UTF-16 code units": the server counts the `.length` of node-pty's
 * string chunks and the client counts the `.length` of the same strings received in WS text frames,
 * so the two ends always agree.
 */

export interface FlowWatermarks {
  /** Pause once the unacked amount exceeds this. */
  high: number;
  /** While paused, resume once the unacked amount drains to at or below this. */
  low: number;
}

export interface FlowState {
  /** Amount sent but not yet acknowledged. */
  unacked: number;
  paused: boolean;
}

export const initialFlowState: FlowState = { unacked: 0, paused: false };

/** Server side: state transition after sending a chunk. Pauses when the high watermark is exceeded. */
export function onBytesSent(
  state: FlowState,
  bytes: number,
  watermarks: FlowWatermarks,
): FlowState {
  const unacked = state.unacked + bytes;
  return { unacked, paused: state.paused || unacked > watermarks.high };
}

/** Server side: state transition after receiving an ACK. Resumes once it drains to the low watermark. */
export function onBytesAcked(
  state: FlowState,
  bytes: number,
  watermarks: FlowWatermarks,
): FlowState {
  const unacked = Math.max(0, state.unacked - bytes);
  return { unacked, paused: state.paused && unacked > watermarks.low };
}

/**
 * Client side: accumulates xterm.js's completed writes and, once the threshold is reached,
 * returns the amount to ACK (if the returned ackBytes is nonzero, send term.ack).
 */
export function tallyWrittenBytes(
  pending: number,
  bytes: number,
  threshold: number,
): { pending: number; ackBytes: number } {
  const total = pending + bytes;
  if (total >= threshold) {
    return { pending: 0, ackBytes: total };
  }
  return { pending: total, ackBytes: 0 };
}
