// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardOverlay } from "./DashboardOverlay.js";

const noop = () => undefined;
afterEach(cleanup);

describe("DashboardOverlay", () => {
  it("frames a web page by address, keeping it out of the app's origin's reach", () => {
    const { container } = render(
      <DashboardOverlay
        frame={{ kind: "remote", url: "https://dash.example/board" }}
        onClose={noop}
      />,
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("https://dash.example/board");
    // An opaque origin: wherever the page navigates the frame, it cannot become same-origin with
    // the cockpit and reach the app's token.
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.getByRole("dialog", { name: "ダッシュボード" })).toBeTruthy();
  });

  it("renders a local file's HTML in an opaque origin", () => {
    const { container } = render(
      <DashboardOverlay
        frame={{ kind: "local", html: "<h1>goals</h1>" }}
        onClose={noop}
      />,
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("srcdoc")).toBe("<h1>goals</h1>");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("src")).toBeNull();
  });

  it("says why the page could not be read instead of framing nothing", () => {
    const { container } = render(
      <DashboardOverlay
        frame={{ kind: "error", detail: "file not found" }}
        onClose={noop}
      />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("file not found");
  });

  it("gives focus back to whatever held it, since it can open while the user is typing", async () => {
    const typingIn = document.createElement("textarea");
    document.body.appendChild(typingIn);
    typingIn.focus();
    expect(document.activeElement).toBe(typingIn);

    const { unmount } = render(
      <DashboardOverlay
        frame={{ kind: "remote", url: "https://dash.example" }}
        onClose={noop}
      />,
    );
    expect(document.activeElement).not.toBe(typingIn);

    unmount();
    await vi.waitFor(() => expect(document.activeElement).toBe(typingIn));
    typingIn.remove();
  });

  it("dismisses on Escape, on a backdrop click, and from the close button", () => {
    const onClose = vi.fn();
    const { container } = render(
      <DashboardOverlay
        frame={{ kind: "remote", url: "https://dash.example" }}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = container.querySelector(".modal-backdrop");
    if (backdrop === null) throw new Error("backdrop missing");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
