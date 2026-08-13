import { describe, expect, it } from "vitest";

import { getHelpTopics, HELP_CATEGORIES } from "./help-content.js";

// Hiragana, katakana, and CJK ideographs — used to assert per-locale content.
const HAS_JP = /[぀-ヿ㐀-鿿]/;

describe("getHelpTopics", () => {
  it("exposes the same set of topic ids in every locale", () => {
    const jaIds = getHelpTopics("ja")
      .map((t) => t.id)
      .sort();
    const enIds = getHelpTopics("en")
      .map((t) => t.id)
      .sort();
    expect(jaIds.length).toBeGreaterThan(0);
    expect(enIds).toEqual(jaIds);
  });

  it("serves Japanese content for ja and English (no Japanese) for en", () => {
    const ja = getHelpTopics("ja");
    const en = getHelpTopics("en");
    expect(ja.some((t) => HAS_JP.test(t.title))).toBe(true);
    expect(en.every((t) => !HAS_JP.test(t.title))).toBe(true);
    expect(en.every((t) => !HAS_JP.test(t.body))).toBe(true);
  });

  it("treats any non-Japanese locale as English (fallback)", () => {
    expect(getHelpTopics("en-US")).toBe(getHelpTopics("en"));
    expect(getHelpTopics("fr")).toBe(getHelpTopics("en"));
    expect(getHelpTopics("")).toBe(getHelpTopics("en"));
  });

  it("resolves any ja-* tag to Japanese", () => {
    expect(getHelpTopics("ja-JP")).toBe(getHelpTopics("ja"));
  });

  it("provides every category-referenced topic in both locales", () => {
    const referenced = HELP_CATEGORIES.flatMap((c) => c.topicIds);
    for (const locale of ["ja", "en"]) {
      const ids = new Set(getHelpTopics(locale).map((t) => t.id));
      for (const id of referenced) expect(ids.has(id)).toBe(true);
    }
  });
});
