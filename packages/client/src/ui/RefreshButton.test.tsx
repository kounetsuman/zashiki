// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RefreshButton } from "./RefreshButton.js";

afterEach(cleanup);

describe("RefreshButton", () => {
  it("idle renders the refresh icon with title=label and no aria-busy", () => {
    render(<RefreshButton state="idle" label="更新" onClick={() => {}} />);
    const btn = screen.getByRole("button", { name: "更新" });
    expect(btn.textContent).toBe("refresh");
    expect(btn.getAttribute("title")).toBe("更新");
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("loading renders a spinner with aria-busy=true (no refresh/warning icon)", () => {
    render(<RefreshButton state="loading" label="更新" onClick={() => {}} />);
    const btn = screen.getByRole("button", { name: "更新" });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.querySelector(".panel-refresh-spinner")).not.toBeNull();
    expect(btn.textContent).not.toContain("refresh");
    expect(btn.textContent).not.toContain("warning");
  });

  it("error renders the warning icon with the error in title (a tooltip visible on hover)", () => {
    render(
      <RefreshButton
        state="error"
        label="更新"
        error="Error: 接続に失敗"
        onClick={() => {}}
      />,
    );
    const btn = screen.getByRole("button", { name: "更新" });
    expect(btn.textContent).toContain("warning");
    expect(btn.getAttribute("title")).toBe("Error: 接続に失敗");
  });

  it("error without an error value falls back to title=label (avoids an empty tooltip)", () => {
    render(<RefreshButton state="error" label="更新" onClick={() => {}} />);
    expect(
      screen.getByRole("button", { name: "更新" }).getAttribute("title"),
    ).toBe("更新");
  });

  it("keeps aria-label fixed to label regardless of state (identity does not shift with state)", () => {
    const { rerender } = render(
      <RefreshButton state="idle" label="更新" onClick={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
    rerender(
      <RefreshButton
        state="error"
        label="更新"
        error="boom"
        onClick={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
  });

  it("calls onClick on click", () => {
    const onClick = vi.fn();
    render(<RefreshButton state="idle" label="更新" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(onClick).toHaveBeenCalled();
  });
});
