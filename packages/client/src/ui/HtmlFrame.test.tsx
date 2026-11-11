// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HTML_FRAME_PAGE, HTML_FRAME_RENDER } from "../lib/html-frame.js";
import { HtmlFrame } from "./HtmlFrame.js";

afterEach(cleanup);

function framePostMessage(frame: HTMLIFrameElement) {
  const window = frame.contentWindow;
  if (window === null) throw new Error("no frame window");
  return vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
}

describe("HtmlFrame", () => {
  it("loads the host page in an opaque origin instead of inlining the HTML", () => {
    const { container } = render(
      <HtmlFrame html="<h1>hi</h1>" title="demo" className="c" />,
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("src")).toBe(HTML_FRAME_PAGE);
    expect(frame?.getAttribute("srcdoc")).toBeNull();
    expect(frame?.title).toBe("demo");
    expect(frame?.className).toBe("c");
  });

  it("hands the HTML to the host page once it has loaded", () => {
    const { container } = render(<HtmlFrame html="<h1>hi</h1>" title="t" />);
    const frame = container.querySelector("iframe");
    if (frame === null) throw new Error("no frame");
    const post = framePostMessage(frame);
    expect(post).not.toHaveBeenCalled();
    frame.dispatchEvent(new Event("load"));
    expect(post).toHaveBeenCalledWith(
      { t: HTML_FRAME_RENDER, html: "<h1>hi</h1>" },
      "*",
    );
  });

  it("hands it over only for the host page's own load, not for pages the content navigates to", () => {
    const { container } = render(<HtmlFrame html="<h1>hi</h1>" title="t" />);
    const frame = container.querySelector("iframe");
    if (frame === null) throw new Error("no frame");
    const post = framePostMessage(frame);
    frame.dispatchEvent(new Event("load"));
    frame.dispatchEvent(new Event("load"));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reloads the host page with the new HTML when the HTML changes", () => {
    const { container, rerender } = render(
      <HtmlFrame html="<h1>one</h1>" title="t" />,
    );
    const frame = container.querySelector("iframe");
    if (frame === null) throw new Error("no frame");
    frame.dispatchEvent(new Event("load"));
    rerender(<HtmlFrame html="<h1>two</h1>" title="t" />);
    const post = framePostMessage(frame);
    frame.dispatchEvent(new Event("load"));
    expect(post).toHaveBeenCalledWith(
      { t: HTML_FRAME_RENDER, html: "<h1>two</h1>" },
      "*",
    );
  });
});
