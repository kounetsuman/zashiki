/** Exponential backoff delay for reconnection (ms). attempt is 0-based. */
export function reconnectDelayMs(
  attempt: number,
  baseMs = 500,
  maxMs = 10_000,
): number {
  const a = Math.max(0, attempt);
  return Math.min(maxMs, baseMs * 2 ** a);
}
