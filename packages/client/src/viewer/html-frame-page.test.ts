// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HTML_FRAME_READY, HTML_FRAME_RENDER } from "../lib/html-frame.js";

const page = readFileSync(
  join(
    import.meta.dirname,
    "../../../../crates/zashiki-server/assets/html-frame.html",
  ),
  "utf8",
);

function startHostPage(): void {
  const script = new DOMParser()
    .parseFromString(page, "text/html")
    .querySelector("script")?.textContent;
  if (script == null) throw new Error("the host page has no script");
  new Function(script)();
}

function stubDocumentRewrite() {
  vi.spyOn(document, "open").mockImplementation(
    (() => document) as typeof document.open,
  );
  vi.spyOn(document, "close").mockImplementation(() => {});
  return vi.spyOn(document, "write").mockImplementation(() => {});
}

function receive(data: unknown, source: MessageEventSource | null): void {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

describe("the HTML frame host page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tells its parent it is ready every time it loads", () => {
    stubDocumentRewrite();
    const post = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation(() => {});
    startHostPage();
    startHostPage();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith({ t: HTML_FRAME_READY }, "*");
    receive({ t: HTML_FRAME_RENDER, html: "" }, window.parent);
  });

  it("writes the HTML its parent sends into its own document, once", () => {
    const write = stubDocumentRewrite();
    vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    startHostPage();
    receive({ t: HTML_FRAME_RENDER, html: "<h1>hi</h1>" }, window.parent);
    receive({ t: HTML_FRAME_RENDER, html: "<h1>again</h1>" }, window.parent);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("<h1>hi</h1>");
  });

  it("ignores messages from anyone but its parent, and messages of another shape", () => {
    const write = stubDocumentRewrite();
    vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    startHostPage();
    const other = new MessageChannel().port1;
    receive({ t: HTML_FRAME_RENDER, html: "<h1>x</h1>" }, other);
    receive({ t: "other", html: "<h1>x</h1>" }, window.parent);
    receive({ t: HTML_FRAME_RENDER, html: 1 }, window.parent);
    expect(write).not.toHaveBeenCalled();
  });
});
