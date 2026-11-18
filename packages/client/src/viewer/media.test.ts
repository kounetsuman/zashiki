import { describe, expect, it } from "vitest";

import { mediaKind, mediaMime } from "./media.js";

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

  it("maps audio extensions to audio", () => {
    expect(mediaKind("Hero.aiff")).toBe("audio");
    expect(mediaKind("song.MP3")).toBe("audio");
    expect(mediaKind("take.wav")).toBe("audio");
    expect(mediaKind("memo.m4a")).toBe("audio");
  });

  it("maps .pdf to pdf", () => {
    expect(mediaKind("spec.pdf")).toBe("pdf");
    expect(mediaKind("Report.PDF")).toBe("pdf");
  });

  it("returns null for text and unknown extensions", () => {
    expect(mediaKind("app.ts")).toBeNull();
    expect(mediaKind("README.md")).toBeNull();
    expect(mediaKind("Makefile")).toBeNull();
    expect(mediaKind("archive.tar.gz")).toBeNull();
  });
});

describe("mediaMime", () => {
  it("gives the MIME type a media file is served as", () => {
    expect(mediaMime("Hero.aiff")).toBe("audio/aiff");
    expect(mediaMime("clip.MOV")).toBe("video/quicktime");
    expect(mediaMime("spec.pdf")).toBe("application/pdf");
  });

  it("is empty for text", () => {
    expect(mediaMime("app.ts")).toBe("");
  });
});
