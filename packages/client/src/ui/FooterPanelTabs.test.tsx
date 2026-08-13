// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FooterPanelTabs } from "./FooterPanelTabs.js";
import { PANEL_DEFS } from "./panels.js";

afterEach(cleanup);

describe("FooterPanelTabs", () => {
  it("renders each panel's switch icon in PANEL_DEFS order (radios in a radiogroup)", () => {
    render(<FooterPanelTabs selected="explorer" onSelect={() => undefined} />);
    const group = screen.getByRole("radiogroup", { name: "パネル切替" });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(PANEL_DEFS.length);
    expect(group.contains(radios[0] ?? null)).toBe(true);
  });

  it("sets aria-checked=true only on the selected panel and false on the others", () => {
    render(<FooterPanelTabs selected="git" onSelect={() => undefined} />);
    const gitBtn = screen.getByRole("radio", { name: "ソース管理" });
    const explorerBtn = screen.getByRole("radio", { name: "エクスプローラー" });
    expect(gitBtn.getAttribute("aria-checked")).toBe("true");
    expect(explorerBtn.getAttribute("aria-checked")).toBe("false");
  });

  it("adds the is-active class to the selected panel's icon (for coloring)", () => {
    render(<FooterPanelTabs selected="search" onSelect={() => undefined} />);
    expect(
      screen
        .getByRole("radio", { name: "検索" })
        .classList.contains("is-active"),
    ).toBe(true);
    expect(
      screen
        .getByRole("radio", { name: "ソース管理" })
        .classList.contains("is-active"),
    ).toBe(false);
  });

  it("does not render a switch icon for the session list (always fixed)", () => {
    render(<FooterPanelTabs selected="explorer" onSelect={() => undefined} />);
    expect(screen.queryByRole("radio", { name: /セッション一覧/ })).toBeNull();
  });

  it("calls onSelect with the target id on click", () => {
    const onSelect = vi.fn();
    render(<FooterPanelTabs selected="explorer" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    expect(onSelect).toHaveBeenCalledWith("git");
  });

  it("shows an unread badge and unread label on panels with badges>0", () => {
    render(
      <FooterPanelTabs
        selected="explorer"
        onSelect={() => undefined}
        badges={{ notification: 3 }}
      />,
    );
    const btn = screen.getByRole("radio", { name: /通知（未読 3）/ });
    expect(btn.querySelector(".footer-panel-badge")?.textContent).toBe("3");
  });

  it("does not show a badge when badges is 0 or unspecified", () => {
    render(
      <FooterPanelTabs
        selected="explorer"
        onSelect={() => undefined}
        badges={{ notification: 0 }}
      />,
    );
    expect(
      screen
        .getByRole("radio", { name: "通知" })
        .querySelector(".footer-panel-badge"),
    ).toBeNull();
  });
});
