import { describe, expect, it } from "vitest";

import { isHttpUrl, isWebLink } from "./web-url.js";

describe("isHttpUrl", () => {
  it("accepts absolute http(s) addresses in any case", () => {
    for (const url of [
      "https://a.example/x",
      "http://a.example",
      "HTTPS://A.EXAMPLE",
    ])
      expect(isHttpUrl(url)).toBe(true);
  });

  it("rejects everything that does not spell out http(s)", () => {
    for (const url of [
      "//a.example/x",
      "a.example",
      "./dash.html",
      "file:///a",
      "mailto:a@b",
      "",
    ])
      expect(isHttpUrl(url)).toBe(false);
  });
});

describe("isWebLink", () => {
  it("also counts a protocol-relative address as leaving the app", () => {
    for (const href of [
      "https://a.example/x",
      "http://a.example",
      "//a.example/x",
    ])
      expect(isWebLink(href)).toBe(true);
  });

  it("keeps in-document, relative and non-web links out", () => {
    for (const href of [
      "#top",
      "./other.md",
      "/docs/a.md",
      "mailto:a@b",
      "javascript:x",
    ])
      expect(isWebLink(href)).toBe(false);
  });
});
