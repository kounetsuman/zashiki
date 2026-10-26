// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  DIAGRAM_BASE_CSS,
  diagramFrame,
  diagramFrameDocument,
  diagramFrameSize,
} from "./diagram-frame.js";

describe("diagramFrameDocument", () => {
  it("forbids every fetch except inline images before the diagram", () => {
    const page = diagramFrameDocument("<svg></svg>");
    const policy = page.indexOf('http-equiv="Content-Security-Policy"');
    expect(policy).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(page.indexOf("<svg>"));
    expect(page).toContain(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:",
    );
  });
});

describe("diagramFrameDocument text metrics", () => {
  it("lays text out with the line height the probe measured it with", () => {
    expect(DIAGRAM_BASE_CSS).not.toContain("line-height");
    expect(diagramFrameDocument("<svg></svg>")).not.toContain("line-height");
  });
});

describe("diagramFrameSize", () => {
  it("keeps the proportions and the widest size of a diagram that fits its container", () => {
    expect(
      diagramFrameSize(
        '<svg width="100%" style="max-width: 320px;" viewBox="-8 -8 320 160"></svg>',
      ),
    ).toEqual({ maxWidth: "320px", aspectRatio: "320 / 160", height: null });
  });

  it("uses the width and height of a diagram of fixed size", () => {
    expect(diagramFrameSize('<svg width="200" height="100"></svg>')).toEqual({
      maxWidth: "200px",
      aspectRatio: "200 / 100",
      height: null,
    });
  });

  it("gives a fixed height to a full-width diagram without proportions", () => {
    expect(diagramFrameSize('<svg width="100%" height="80"></svg>')).toEqual({
      maxWidth: null,
      aspectRatio: null,
      height: "80px",
    });
  });
});

describe("diagramFrame", () => {
  it("takes neither keyboard focus nor the pointer", () => {
    const frame = diagramFrame("<svg></svg>", "Diagram");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.style.pointerEvents).toBe("none");
  });
});
