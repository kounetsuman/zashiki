import { describe, expect, it } from "vitest";

import { reconnectDelayMs } from "./backoff.js";

describe("reconnectDelayMs", () => {
  it("grows exponentially", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(3)).toBe(4000);
  });
  it("caps at the upper limit", () => {
    expect(reconnectDelayMs(10)).toBe(10_000);
    expect(reconnectDelayMs(100)).toBe(10_000);
  });
  it("treats a negative attempt as 0", () => {
    expect(reconnectDelayMs(-1)).toBe(500);
  });
});
