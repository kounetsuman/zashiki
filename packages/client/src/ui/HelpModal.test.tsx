// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HelpCategoryDef, HelpTopic } from "../help/help-model.js";
import { HelpModal } from "./HelpModal.js";

const topics: HelpTopic[] = [
  {
    id: "repos-conf",
    order: 1,
    title: "repos.conf と org の色",
    body: "行末に `#RRGGBB` を書くと org に色が付く。\n\n- 色未指定は白",
  },
  {
    id: "keybindings",
    order: 2,
    title: "キーバインド",
    body: "## セッション\n`Ctrl-N` で新規セッション。",
  },
];

const categories: HelpCategoryDef[] = [
  { id: "config", titleKey: "設定ファイル", topicIds: ["repos-conf"] },
  { id: "general", titleKey: "全般", topicIds: ["keybindings"] },
];

const noop = () => {};

afterEach(cleanup);

describe("HelpModal", () => {
  it("renders a labeled dialog with one tab per category, the first active", () => {
    render(
      <HelpModal topics={topics} categories={categories} onClose={noop} />,
    );
    expect(screen.getByRole("dialog", { name: "ヘルプ" })).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "設定ファイル" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "全般" }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("renders the active category's topic body (markdown) and hides other categories", () => {
    render(
      <HelpModal topics={topics} categories={categories} onClose={noop} />,
    );
    expect(screen.getByText("repos.conf と org の色")).toBeTruthy();
    expect(screen.getByText("色未指定は白").closest("li")).not.toBeNull();
    expect(screen.getByText("#RRGGBB").tagName).toBe("CODE");
    expect(screen.queryByText("キーバインド")).toBeNull();
  });

  it("switches the body when another tab is selected", () => {
    render(
      <HelpModal topics={topics} categories={categories} onClose={noop} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "全般" }));
    expect(screen.getByText("キーバインド")).toBeTruthy();
    expect(screen.getByText(/新規セッション/)).toBeTruthy();
    expect(screen.queryByText("repos.conf と org の色")).toBeNull();
  });

  it("search surfaces cross-category matches regardless of the active tab", () => {
    render(
      <HelpModal topics={topics} categories={categories} onClose={noop} />,
    );
    fireEvent.change(screen.getByLabelText("ヘルプを検索"), {
      target: { value: "ctrl-n" },
    });
    expect(screen.getByText("キーバインド")).toBeTruthy();
    expect(screen.getByText(/新規セッション/)).toBeTruthy();
    expect(screen.queryByText("repos.conf と org の色")).toBeNull();
  });

  it("shows the empty state when nothing matches the search", () => {
    render(
      <HelpModal topics={topics} categories={categories} onClose={noop} />,
    );
    fireEvent.change(screen.getByLabelText("ヘルプを検索"), {
      target: { value: "存在しない語" },
    });
    expect(screen.getByText("該当するヘルプがありません")).toBeTruthy();
  });

  it("selecting a tab clears an active search", () => {
    render(
      <HelpModal topics={topics} categories={categories} onClose={noop} />,
    );
    fireEvent.change(screen.getByLabelText("ヘルプを検索"), {
      target: { value: "ctrl-n" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "設定ファイル" }));
    expect(
      (screen.getByLabelText("ヘルプを検索") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByText("repos.conf と org の色")).toBeTruthy();
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    render(
      <HelpModal topics={topics} categories={categories} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders with the default bundled topics (content/*.md)", () => {
    render(<HelpModal onClose={noop} />);
    expect(screen.getByRole("dialog", { name: "ヘルプ" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "設定ファイル" })).toBeTruthy();
  });
});
