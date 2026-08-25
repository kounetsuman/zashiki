import { describe, expect, it } from "vitest";

import { stripSurroundingSlashes, stripTrailingSlashes } from "./path-slash.js";

describe("stripTrailingSlashes", () => {
  it("removes a trailing run and keeps inner separators", () => {
    expect(stripTrailingSlashes("/a/b/")).toBe("/a/b");
    expect(stripTrailingSlashes("/a/b///")).toBe("/a/b");
    expect(stripTrailingSlashes("/a/b")).toBe("/a/b");
  });

  it("collapses an all-slash or empty path to empty", () => {
    expect(stripTrailingSlashes("/")).toBe("");
    expect(stripTrailingSlashes("///")).toBe("");
    expect(stripTrailingSlashes("")).toBe("");
  });

  it("stays linear on a long slash run (ReDoS guard)", () => {
    const start = performance.now();
    stripTrailingSlashes(`/a${"/".repeat(200000)}`);
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe("stripSurroundingSlashes", () => {
  it("removes leading and trailing runs and keeps inner separators", () => {
    expect(stripSurroundingSlashes("/src/")).toBe("src");
    expect(stripSurroundingSlashes("//a/b//")).toBe("a/b");
    expect(stripSurroundingSlashes("a/b")).toBe("a/b");
  });

  it("collapses an all-slash or empty path to empty", () => {
    expect(stripSurroundingSlashes("///")).toBe("");
    expect(stripSurroundingSlashes("")).toBe("");
  });

  it("stays linear on a long slash run (ReDoS guard)", () => {
    const start = performance.now();
    stripSurroundingSlashes(`${"/".repeat(200000)}a${"/".repeat(200000)}`);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
