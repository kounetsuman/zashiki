import { describe, expect, it } from "vitest";

import { mediaKind } from "./media.js";

describe("mediaKind", () => {
  it("maps image extensions to image (case-insensitive)", () => {
    expect(mediaKind("a.png")).toBe("image");
    expect(mediaKind("photo.JPG")).toBe("image");
    expect(mediaKind("icon.svg")).toBe("image");
    expect(mediaKind("shot.webp")).toBe("image");
  });

  it("maps video extensions to video", () => {
    expect(mediaKind("clip.mp4")).toBe("video");
    expect(mediaKind("screen.webm")).toBe("video");
    expect(mediaKind("recording.MOV")).toBe("video");
  });

  it("returns null for text and unknown extensions", () => {
    expect(mediaKind("app.ts")).toBeNull();
    expect(mediaKind("README.md")).toBeNull();
    expect(mediaKind("Makefile")).toBeNull();
    expect(mediaKind("archive.tar.gz")).toBeNull();
  });
});
