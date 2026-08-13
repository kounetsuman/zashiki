import { describe, expect, it } from "vitest";

import { formatSessionName } from "./domain.js";
import { healthResponseSchema } from "./protocol.js";

describe("formatSessionName", () => {
  it("trims leading and trailing whitespace", () => {
    expect(formatSessionName("  main  ")).toBe("main");
  });

  it("returns as-is when at or below maxLength", () => {
    expect(formatSessionName("short", 10)).toBe("short");
  });

  it("truncates the tail with an ellipsis when it exceeds maxLength", () => {
    expect(formatSessionName("abcdefghij", 5)).toBe("abcd…");
    expect(formatSessionName("abcdefghij", 5)).toHaveLength(5);
  });
});

describe("healthResponseSchema", () => {
  it("accepts status: ok", () => {
    expect(healthResponseSchema.parse({ status: "ok" })).toEqual({
      status: "ok",
    });
  });

  it("rejects an invalid status", () => {
    expect(() => healthResponseSchema.parse({ status: "ng" })).toThrow();
  });
});
