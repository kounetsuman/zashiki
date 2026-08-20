// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FooterViewTabs } from "./FooterViewTabs.js";
import { VIEW_DEFS } from "./views.js";

afterEach(cleanup);

describe("FooterViewTabs", () => {
  it("renders each view's switch icon in VIEW_DEFS order (radios in a radiogroup)", () => {
    render(<FooterViewTabs selected="explorer" onSelect={() => undefined} />);
    const group = screen.getByRole("radiogroup", { name: "ビュー切替" });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(VIEW_DEFS.length);
    expect(group.contains(radios[0] ?? null)).toBe(true);
  });

  it("sets aria-checked=true only on the selected view and false on the others", () => {
    render(
      <FooterViewTabs selected="sourceControl" onSelect={() => undefined} />,
    );
    const gitBtn = screen.getByRole("radio", { name: "ソース管理" });
    const explorerBtn = screen.getByRole("radio", { name: "エクスプローラー" });
    expect(gitBtn.getAttribute("aria-checked")).toBe("true");
    expect(explorerBtn.getAttribute("aria-checked")).toBe("false");
  });

  it("adds the is-active class to the selected view's icon (for coloring)", () => {
    render(<FooterViewTabs selected="search" onSelect={() => undefined} />);
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
    render(<FooterViewTabs selected="explorer" onSelect={() => undefined} />);
    expect(screen.queryByRole("radio", { name: /セッション一覧/ })).toBeNull();
  });

  it("calls onSelect with the target id on click", () => {
    const onSelect = vi.fn();
    render(<FooterViewTabs selected="explorer" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    expect(onSelect).toHaveBeenCalledWith("sourceControl");
  });

  it("shows an unread badge and unread label on views with badges>0", () => {
    render(
      <FooterViewTabs
        selected="explorer"
        onSelect={() => undefined}
        badges={{ notification: 3 }}
      />,
    );
    const btn = screen.getByRole("radio", { name: /通知（未読 3）/ });
    expect(btn.querySelector(".footer-view-badge")?.textContent).toBe("3");
  });

  it("does not show a badge when badges is 0 or unspecified", () => {
    render(
      <FooterViewTabs
        selected="explorer"
        onSelect={() => undefined}
        badges={{ notification: 0 }}
      />,
    );
    expect(
      screen
        .getByRole("radio", { name: "通知" })
        .querySelector(".footer-view-badge"),
    ).toBeNull();
  });
});
