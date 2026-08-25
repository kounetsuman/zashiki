// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigationBar } from "./NavigationBar.js";
import { VIEW_DEFS } from "./views.js";

afterEach(cleanup);

const noop = () => undefined;

describe("NavigationBar", () => {
  it("renders each view's switch icon in VIEW_DEFS order (radios in a radiogroup)", () => {
    render(
      <NavigationBar
        selected="explorer"
        onSelect={noop}
        onOpenSettings={noop}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "ビュー切替" });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(VIEW_DEFS.length);
    expect(group.contains(radios[0] ?? null)).toBe(true);
  });

  it("sets aria-checked=true only on the selected view and false on the others", () => {
    render(
      <NavigationBar
        selected="sourceControl"
        onSelect={noop}
        onOpenSettings={noop}
      />,
    );
    expect(
      screen
        .getByRole("radio", { name: "ソース管理" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "エクスプローラー" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("marks no view active when the LEFT area is closed (selected=null)", () => {
    render(
      <NavigationBar selected={null} onSelect={noop} onOpenSettings={noop} />,
    );
    for (const r of screen.getAllByRole("radio")) {
      expect(r.getAttribute("aria-checked")).toBe("false");
      expect(r.classList.contains("is-active")).toBe(false);
    }
  });

  it("adds the is-active class to the selected view's icon (for coloring)", () => {
    render(
      <NavigationBar selected="search" onSelect={noop} onOpenSettings={noop} />,
    );
    expect(
      screen
        .getByRole("radio", { name: "検索" })
        .classList.contains("is-active"),
    ).toBe(true);
  });

  it("does not render a switch icon for the session list (always fixed)", () => {
    render(
      <NavigationBar
        selected="explorer"
        onSelect={noop}
        onOpenSettings={noop}
      />,
    );
    expect(screen.queryByRole("radio", { name: /セッション一覧/ })).toBeNull();
  });

  it("calls onSelect with the target id on click", () => {
    const onSelect = vi.fn();
    render(
      <NavigationBar
        selected="explorer"
        onSelect={onSelect}
        onOpenSettings={noop}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    expect(onSelect).toHaveBeenCalledWith("sourceControl");
  });

  it("shows an unread badge and unread label on views with badges>0", () => {
    render(
      <NavigationBar
        selected="explorer"
        onSelect={noop}
        onOpenSettings={noop}
        badges={{ notification: 3 }}
      />,
    );
    const btn = screen.getByRole("radio", { name: /通知（未読 3）/ });
    expect(btn.querySelector(".nav-badge")?.textContent).toBe("3");
  });

  it("does not show a badge when badges is 0 or unspecified", () => {
    render(
      <NavigationBar
        selected="explorer"
        onSelect={noop}
        onOpenSettings={noop}
        badges={{ notification: 0 }}
      />,
    );
    expect(
      screen.getByRole("radio", { name: "通知" }).querySelector(".nav-badge"),
    ).toBeNull();
  });

  it("renders the settings gear as a plain button (not a radio) and calls onOpenSettings on click", () => {
    const onOpenSettings = vi.fn();
    render(
      <NavigationBar
        selected="explorer"
        onSelect={noop}
        onOpenSettings={onOpenSettings}
      />,
    );
    const btn = screen.getByRole("button", { name: "設定" });
    expect(btn.getAttribute("role")).toBeNull();
    fireEvent.click(btn);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
