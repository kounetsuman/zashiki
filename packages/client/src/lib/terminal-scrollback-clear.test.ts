import { describe, expect, it } from "vitest";

import { clearsScrollback } from "./terminal-scrollback-clear.js";

describe("clearsScrollback", () => {
  it("detects the erase-scrollback sequence the server's history rebuild opens with", () => {
    expect(clearsScrollback("\x1b[?1049l\x1b[H\x1b[2J\x1b[3Jhello")).toBe(true);
  });

  it("detects it mid-chunk (a program clearing its own scrollback)", () => {
    expect(clearsScrollback("done\r\n\x1b[3J")).toBe(true);
  });

  it("does not fire on ordinary output or on erasing only the screen", () => {
    expect(clearsScrollback("3J is not an escape sequence\r\n")).toBe(false);
    expect(clearsScrollback("\x1b[2J\x1b[H")).toBe(false);
  });

  it("does not fire on a different erase parameter that ends in 3", () => {
    expect(clearsScrollback("\x1b[23J")).toBe(false);
  });
});
