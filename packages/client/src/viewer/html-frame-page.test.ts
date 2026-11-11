// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HTML_FRAME_PAGE, HTML_FRAME_RENDER } from "../lib/html-frame.js";

const page = readFileSync(
  join(import.meta.dirname, "../../public", HTML_FRAME_PAGE),
  "utf8",
);

function startHostPage(): void {
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];
  if (script === undefined) throw new Error("the host page has no script");
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

  it("writes the HTML its parent sends into its own document, once", () => {
    const write = stubDocumentRewrite();
    startHostPage();
    receive({ t: HTML_FRAME_RENDER, html: "<h1>hi</h1>" }, window.parent);
    receive({ t: HTML_FRAME_RENDER, html: "<h1>again</h1>" }, window.parent);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("<h1>hi</h1>");
  });

  it("ignores messages from anyone but its parent, and messages of another shape", () => {
    const write = stubDocumentRewrite();
    startHostPage();
    const other = new MessageChannel().port1;
    receive({ t: HTML_FRAME_RENDER, html: "<h1>x</h1>" }, other);
    receive({ t: "other", html: "<h1>x</h1>" }, window.parent);
    receive({ t: HTML_FRAME_RENDER, html: 1 }, window.parent);
    expect(write).not.toHaveBeenCalled();
  });
});
