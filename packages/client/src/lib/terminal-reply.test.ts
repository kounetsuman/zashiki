import { describe, expect, it } from "vitest";

import { stripTerminalReplies } from "./terminal-reply.js";

describe("stripTerminalReplies", () => {
  it("strips a DA1 primary device-attributes reply (CSI ? ... c)", () => {
    expect(stripTerminalReplies("\x1b[?1;2c")).toBe("");
  });

  it("strips a DA2 secondary device-attributes reply (CSI > ... c)", () => {
    expect(stripTerminalReplies("\x1b[>0;276;0c")).toBe("");
  });

  it("strips an OSC 11 background-color report (BEL- and ST-terminated)", () => {
    expect(stripTerminalReplies("\x1b]11;rgb:1414/1414/1414\x07")).toBe("");
    expect(stripTerminalReplies("\x1b]11;rgb:1414/1414/1414\x1b\\")).toBe("");
  });

  it("strips OSC 10/12 foreground and cursor color reports", () => {
    expect(stripTerminalReplies("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBe("");
    expect(stripTerminalReplies("\x1b]12;rgb:0000/0000/0000\x07")).toBe("");
  });

  it("strips an XTVERSION DCS reply (DCS > | ... ST)", () => {
    expect(stripTerminalReplies("\x1bP>|xterm.js(6.1.0-beta.292)\x1b\\")).toBe(
      "",
    );
  });

  it("strips DSR cursor-position reports, with or without the ? prefix", () => {
    expect(stripTerminalReplies("\x1b[24;80R")).toBe("");
    expect(stripTerminalReplies("\x1b[?24;80R")).toBe("");
  });

  it("strips DSR device/mode status reports (CSI ... n)", () => {
    expect(stripTerminalReplies("\x1b[0n")).toBe("");
    expect(stripTerminalReplies("\x1b[?997;1n")).toBe("");
  });

  it("strips a window-size report (CSI Ps;Ps;Ps t)", () => {
    expect(stripTerminalReplies("\x1b[8;24;80t")).toBe("");
  });

  it("strips the full burst observed on window switch at a bare prompt", () => {
    const burst =
      "\x1b]11;rgb:1414/1414/1414\x07" +
      "\x1b[?1;2c" +
      "\x1bP>|xterm.js(6.1.0-beta.292)\x1b\\" +
      "\x1b[?1;2c";
    expect(stripTerminalReplies(burst)).toBe("");
  });

  it("does not swallow non-XTVERSION DCS on the input path", () => {
    // termcap queries, sixel, and DCS embedded in pasted text must survive: only the
    // XTVERSION ">|" form is a reply we generated, everything else is legitimate input.
    expect(stripTerminalReplies("\x1bP+q544e\x1b\\")).toBe("\x1bP+q544e\x1b\\");
    expect(stripTerminalReplies("\x1bPq#0;2;0;0;0#0~~\x1b\\")).toBe(
      "\x1bPq#0;2;0;0;0#0~~\x1b\\",
    );
    expect(stripTerminalReplies("data\x1bPevil\x1b\\more")).toBe(
      "data\x1bPevil\x1b\\more",
    );
  });

  it("keeps typed input surrounding a reply", () => {
    expect(stripTerminalReplies("\x1b]11;rgb:1414/1414/1414\x07ls\r")).toBe(
      "ls\r",
    );
    expect(stripTerminalReplies("ls\r\x1b[?1;2c")).toBe("ls\r");
  });

  it("preserves keystroke CSI (arrow keys) and plain input", () => {
    expect(stripTerminalReplies("\x1b[A")).toBe("\x1b[A");
    expect(stripTerminalReplies("\x1b[B")).toBe("\x1b[B");
    expect(stripTerminalReplies("ls\r")).toBe("ls\r");
    expect(stripTerminalReplies("")).toBe("");
  });
});
