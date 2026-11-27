import { describe, expect, it } from "vitest";

import {
  audioContentType,
  MEDIA_EXTENSIONS,
  mediaContentType,
  mediaKind,
} from "./media.js";

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
    for (const name of [
      "a.mp3",
      "a.m4a",
      "a.aac",
      "a.wav",
      "a.aiff",
      "a.aif",
      "a.flac",
      "a.ogg",
      "a.oga",
      "a.OPUS",
    ]) {
      expect(mediaKind(name), name).toBe("audio");
    }
  });

  it("maps font extensions to font", () => {
    for (const name of ["a.ttf", "a.otf", "a.woff", "a.WOFF2"]) {
      expect(mediaKind(name), name).toBe("font");
    }
  });

  it("leaves containers the webview cannot play as non-media", () => {
    expect(mediaKind("clip.avi")).toBeNull();
    expect(mediaKind("clip.mkv")).toBeNull();
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

describe("audioContentType", () => {
  it("gives the content type /api/media serves for an audio extension", () => {
    expect(audioContentType("a.mp3")).toBe("audio/mpeg");
    expect(audioContentType("a.OPUS")).toBe("audio/ogg");
    expect(audioContentType("a.aif")).toBe("audio/aiff");
  });

  it("returns undefined for a non-audio name", () => {
    expect(audioContentType("clip.mp4")).toBeUndefined();
  });
});

describe("mediaContentType", () => {
  it("types every media extension the way the webview needs to render it", () => {
    expect(mediaContentType("logo.SVG")).toBe("image/svg+xml");
    expect(mediaContentType("clip.mov")).toBe("video/quicktime");
    expect(mediaContentType("doc.pdf")).toBe("application/pdf");
    expect(mediaContentType("note.md")).toBeUndefined();
  });
});

describe("MEDIA_EXTENSIONS", () => {
  it("lists exactly the extensions mediaKind renders as media, each with a content type", () => {
    for (const ext of MEDIA_EXTENSIONS) {
      expect(mediaKind(`f.${ext}`)).not.toBeNull();
      expect(mediaContentType(`f.${ext}`)).toBeDefined();
    }
    expect(MEDIA_EXTENSIONS).toContain("png");
    expect(MEDIA_EXTENSIONS).not.toContain("md");
  });
});
