import { describe, expect, it } from "vitest";

import { stripFocusReports } from "./focus-report.js";

describe("stripFocusReports", () => {
  it("strips focus-in (ESC[I)", () => {
    expect(stripFocusReports("\x1b[I")).toBe("");
  });

  it("strips focus-out (ESC[O)", () => {
    expect(stripFocusReports("\x1b[O")).toBe("");
  });

  it("keeps only the body from input with focus reports before and after", () => {
    expect(stripFocusReports("\x1b[Ils\r")).toBe("ls\r");
    expect(stripFocusReports("ls\r\x1b[O")).toBe("ls\r");
  });

  it("strips all focus reports within a chunk", () => {
    expect(stripFocusReports("\x1b[O\x1b[Ihi\x1b[O")).toBe("hi");
  });

  it("returns input without focus reports unchanged", () => {
    expect(stripFocusReports("ls\r")).toBe("ls\r");
    expect(stripFocusReports("")).toBe("");
  });

  it("preserves other CSI sequences (arrow keys, etc.)", () => {
    // ESC[A (Up) / ESC[Z (Shift+Tab) are not focus reports, so keep them
    expect(stripFocusReports("\x1b[A")).toBe("\x1b[A");
    expect(stripFocusReports("\x1b[Z")).toBe("\x1b[Z");
    expect(stripFocusReports("\x1b\r")).toBe("\x1b\r");
  });
});
