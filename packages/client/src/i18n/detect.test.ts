import { describe, expect, it } from "vitest";

import { detectLocale } from "./detect.js";

describe("detectLocale", () => {
  it("?lang=ja / ?lang=en take top priority", () => {
    expect(detectLocale(["en-US"], "?lang=ja")).toBe("ja");
    expect(detectLocale(["ja"], "?lang=en")).toBe("en");
  });

  it("ignores an unsupported ?lang and falls back to the browser language", () => {
    expect(detectLocale(["ja"], "?lang=fr")).toBe("ja");
    expect(detectLocale(["de-DE"], "?lang=fr")).toBe("en");
  });

  it("ja when the browser language is ja-family (region subtag, case-insensitive)", () => {
    expect(detectLocale(["ja-JP"], "")).toBe("ja");
    expect(detectLocale(["JA"], "")).toBe("ja");
    expect(detectLocale(["en-US", "ja"], "")).toBe("ja");
  });

  it("everything non-ja or undetectable falls back to en (matching the fallback)", () => {
    expect(detectLocale(["en-US"], "")).toBe("en");
    expect(detectLocale([], "")).toBe("en");
    expect(detectLocale(undefined, "")).toBe("en");
  });
});
