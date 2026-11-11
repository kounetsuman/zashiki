// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HTML_FRAME_READY,
  HTML_FRAME_RENDER,
  htmlFrameUrl,
} from "../lib/html-frame.js";
import { HtmlFrame } from "./HtmlFrame.js";

afterEach(cleanup);

function renderedFrame(html: string) {
  const view = render(<HtmlFrame html={html} title="t" />);
  const frame = view.container.querySelector("iframe");
  const frameWindow = frame?.contentWindow;
  if (frame === null || frameWindow == null) throw new Error("no frame");
  const post = vi
    .spyOn(frameWindow, "postMessage")
    .mockImplementation(() => undefined);
  return { ...view, frame, frameWindow, post };
}

function receive(data: unknown, source: MessageEventSource | null): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

describe("HtmlFrame", () => {
  it("loads the host page, from another origin than the app's, in an opaque origin instead of inlining the HTML", () => {
    const { container } = render(
      <HtmlFrame html="<h1>hi</h1>" title="demo" className="c" />,
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("src")).toBe(
      htmlFrameUrl(window.location.origin),
    );
    expect(new URL(frame?.src ?? "").origin).not.toBe(window.location.origin);
    expect(frame?.getAttribute("srcdoc")).toBeNull();
    expect(frame?.title).toBe("demo");
    expect(frame?.className).toBe("c");
  });

  it("hands the HTML over each time the host page says it is ready, so a reloading page is drawn again", () => {
    const { frameWindow, post } = renderedFrame("<h1>hi</h1>");
    expect(post).not.toHaveBeenCalled();
    receive({ t: HTML_FRAME_READY }, frameWindow);
    receive({ t: HTML_FRAME_READY }, frameWindow);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      { t: HTML_FRAME_RENDER, html: "<h1>hi</h1>" },
      "*",
    );
  });

  it("answers only its own frame's well-formed ready message", () => {
    const { post } = renderedFrame("<h1>hi</h1>");
    receive({ t: HTML_FRAME_READY }, window);
    receive({ t: HTML_FRAME_READY }, null);
    const { frameWindow } = renderedFrame("<h1>other</h1>");
    receive({ t: "other" }, frameWindow);
    receive("ready", frameWindow);
    expect(post).not.toHaveBeenCalled();
  });

  it("answers a ready that arrives after the HTML changed with the current HTML only", () => {
    const { frame, rerender } = renderedFrame("<h1>one</h1>");
    rerender(<HtmlFrame html="<h1>two</h1>" title="t" />);
    const frameWindow = frame.contentWindow;
    if (frameWindow === null) throw new Error("no frame window");
    const post = vi
      .spyOn(frameWindow, "postMessage")
      .mockImplementation(() => undefined);
    receive({ t: HTML_FRAME_READY }, frameWindow);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      { t: HTML_FRAME_RENDER, html: "<h1>two</h1>" },
      "*",
    );
  });
});
