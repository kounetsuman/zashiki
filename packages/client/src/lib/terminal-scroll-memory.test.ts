import { describe, expect, it } from "vitest";

import {
  restoreStep,
  SCROLL_RESTORE_WINDOW_MS,
  scrolledBackLine,
} from "./terminal-scroll-memory.js";

describe("scrolledBackLine", () => {
  it("remembers the top line of a viewport scrolled back into the history", () => {
    expect(
      scrolledBackLine({ type: "normal", viewportY: 120, baseY: 400 }),
    ).toBe(120);
  });

  it("remembers the very top of the history", () => {
    expect(scrolledBackLine({ type: "normal", viewportY: 0, baseY: 400 })).toBe(
      0,
    );
  });

  it("remembers nothing for a viewport on the latest output, so it keeps following on return", () => {
    expect(
      scrolledBackLine({ type: "normal", viewportY: 400, baseY: 400 }),
    ).toBeNull();
  });

  it("remembers nothing for a full-screen program, which scrolls by itself", () => {
    expect(
      scrolledBackLine({ type: "alternate", viewportY: 0, baseY: 0 }),
    ).toBeNull();
  });
});

describe("restoreStep", () => {
  it("waits while the replayed history does not reach past the remembered line", () => {
    expect(restoreStep(120, 80, 0)).toBe("wait");
    expect(restoreStep(120, 120, 0)).toBe("wait");
  });

  it("scrolls back once the history reaches past the remembered line", () => {
    expect(restoreStep(120, 121, 0)).toBe("scroll");
  });

  it("waits for a scrollback before restoring the very top (xterm keeps following until scrolled up)", () => {
    expect(restoreStep(0, 0, 0)).toBe("wait");
    expect(restoreStep(0, 1, 0)).toBe("scroll");
  });

  it("gives up once the replay is over without reaching the line, instead of jumping up later", () => {
    expect(restoreStep(120, 80, SCROLL_RESTORE_WINDOW_MS)).toBe("give-up");
    expect(restoreStep(120, 400, SCROLL_RESTORE_WINDOW_MS)).toBe("give-up");
  });
});
