import { describe, expect, it } from "vitest";
import {
  dropOutsideWindow,
  popOutCockpitTerminalId,
  popOutUrl,
} from "./pop-out.js";

describe("popOutUrl / popOutCockpitTerminalId", () => {
  it("round-trips the Cockpit Terminal through the pop-out address", () => {
    const url = popOutUrl(
      { origin: "http://127.0.0.1:8790", pathname: "/" },
      "@2",
      "tok/en",
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://127.0.0.1:8790");
    expect(parsed.pathname).toBe("/");
    expect(parsed.searchParams.get("token")).toBe("tok/en");
    expect(popOutCockpitTerminalId(parsed.search)).toBe("@2");
  });

  it("reads the main window (no or empty parameter) as null", () => {
    expect(popOutCockpitTerminalId("")).toBeNull();
    expect(popOutCockpitTerminalId("?token=abc")).toBeNull();
    expect(popOutCockpitTerminalId("?popOut=")).toBeNull();
  });
});

describe("dropOutsideWindow", () => {
  const viewport = { width: 1280, height: 840 };
  const end = (
    clientX: number,
    clientY: number,
    dropEffect = "none",
    screenX = clientX + 100,
    screenY = clientY + 50,
  ) => ({ dropEffect, clientX, clientY, screenX, screenY });

  it.each([
    ["right of the window", end(1400, 120)],
    ["left of the window", end(-30, 120)],
    ["above the window", end(400, -10)],
    ["below the window", end(400, 900)],
  ])("returns the screen point for a drop %s", (_, e) => {
    expect(dropOutsideWindow(e, viewport)).toEqual({
      x: e.screenX,
      y: e.screenY,
    });
  });

  it("ignores a drop inside the window", () => {
    expect(dropOutsideWindow(end(600, 400), viewport)).toBeNull();
  });

  it("ignores a drop another target accepted", () => {
    expect(dropOutsideWindow(end(1400, 120, "move"), viewport)).toBeNull();
  });

  it("treats all-zero coordinates as an unknown position", () => {
    expect(dropOutsideWindow(end(0, 0, "none", 0, 0), viewport)).toBeNull();
  });
});
