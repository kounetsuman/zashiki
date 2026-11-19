// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserLinks } from "./useBrowserLinks.js";

const { isTauri, invoke } = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn((_command: string, _args: unknown) => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri, invoke }));

function Probe({ children }: { children?: React.ReactNode }) {
  useBrowserLinks();
  return <>{children}</>;
}

function link(href: string, target?: string) {
  return (
    <a href={href} target={target}>
      <span>open</span>
    </a>
  );
}

/** Clicks the link's inner text, as a user would, and says whether the WebView would follow it. */
function click(init: MouseEventInit = {}): boolean {
  const inner = document.querySelector("a span");
  if (inner === null) throw new Error("no link rendered");
  return inner.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
  );
}

beforeEach(() => {
  isTauri.mockReturnValue(true);
  invoke.mockClear();
});
afterEach(cleanup);

describe("useBrowserLinks", () => {
  it("hands a web link that opens a new window to the shell instead of the WebView", () => {
    render(<Probe>{link("https://github.com/o/r/pull/1", "_blank")}</Probe>);

    expect(click()).toBe(false);
    expect(invoke).toHaveBeenCalledWith("open_in_browser", {
      url: "https://github.com/o/r/pull/1",
    });
  });

  it("leaves links that stay in the window, and non-web links, to the WebView", () => {
    for (const each of [
      link("https://example.com/"),
      link("mailto:a@example.com", "_blank"),
    ]) {
      const { unmount } = render(<Probe>{each}</Probe>);
      expect(click()).toBe(true);
      unmount();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores a click another handler has already taken", () => {
    render(<Probe>{link("https://example.com/", "_blank")}</Probe>);
    document
      .querySelector("a")
      ?.addEventListener("click", (e) => e.preventDefault());
    click();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores buttons other than the main one", () => {
    render(<Probe>{link("https://example.com/", "_blank")}</Probe>);
    click({ button: 1 });

    expect(invoke).not.toHaveBeenCalled();
  });

  it("does nothing outside the desktop app, where the browser opens the link itself", () => {
    isTauri.mockReturnValue(false);
    render(<Probe>{link("https://example.com/", "_blank")}</Probe>);

    expect(click()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    const { unmount } = render(<Probe />);
    unmount();
    document.body.innerHTML =
      '<a href="https://example.com/" target="_blank"><span>open</span></a>';

    expect(click()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
