import { describe, expect, it } from "vitest";

import { remoteImageHost } from "./remote-host.js";

describe("remoteImageHost", () => {
  it.each([
    ["https://img.example/a.png", "img.example"],
    ["//img.example/a.png", "img.example"],
    ["HTTPS://IMG.example/a.png", "img.example"],
    ["  https://img.example/a.png", "img.example"],
    ["/\\img.example/a.png", "img.example"],
    ["\\\\img.example/a.png", "img.example"],
    ["http:img.example/a.png", "img.example"],
    ["http:/img.example/a.png", "img.example"],
    ["http://repo.invalid/a.png", "repo.invalid"],
  ])("treats %s as remote", (src, host) => {
    expect(remoteImageHost(src)).toBe(host);
  });

  it.each([
    "docs/a.png",
    "./a.png",
    "../a.png",
    "/a.png",
    "a.png?x=1#y",
    "data:image/png;base64,AAAA",
    "blob:http://localhost:5173/0b1e6c2e-1f5d-4c2a-9d0b-7f0c1b2a3d4e",
  ])("treats %s as not remote", (src) => {
    expect(remoteImageHost(src)).toBeNull();
  });

  it("labels an unparsable remote source with the source itself", () => {
    expect(remoteImageHost("http://[bad/a.png")).toBe("http://[bad/a.png");
  });

  it("shortens a long unparsable remote source label", () => {
    const src = `http://[bad/${"a".repeat(100)}.png`;
    const label = remoteImageHost(src) ?? "";
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.startsWith("http://[bad/")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
  });
});
