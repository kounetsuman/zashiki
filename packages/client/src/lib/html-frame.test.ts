import { describe, expect, it } from "vitest";

import { htmlFrameUrl } from "./html-frame.js";

describe("htmlFrameUrl", () => {
  it("serves the host page from the server under its other loopback name, never the app's origin", () => {
    expect(htmlFrameUrl("http://127.0.0.1:8790")).toBe(
      "http://localhost:8790/html-frame.html",
    );
    expect(htmlFrameUrl("http://localhost:8794/")).toBe(
      "http://127.0.0.1:8794/html-frame.html",
    );
  });
});
