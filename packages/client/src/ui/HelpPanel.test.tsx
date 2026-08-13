// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { HelpCategoryDef, HelpTopic } from "../help/help-model.js";
import { HelpPanel } from "./HelpPanel.js";

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

afterEach(cleanup);

describe("HelpPanel", () => {
  it("shows the HELP header and every item's title", () => {
    render(<HelpPanel topics={topics} />);
    expect(screen.getByText("HELP")).toBeTruthy();
    expect(screen.getByText("repos.conf と org の色")).toBeTruthy();
    expect(screen.getByText("キーバインド")).toBeTruthy();
  });

  it("accordion-expands the body on heading click (markdown rendering)", () => {
    render(<HelpPanel topics={topics} />);
    // Collapsed by default, so the body is not shown.
    expect(screen.queryByText(/色未指定は白/)).toBeNull();
    fireEvent.click(screen.getByText("repos.conf と org の色"));
    // List items are rendered as li.
    expect(screen.getByText("色未指定は白").closest("li")).not.toBeNull();
    // Inline code is a code element.
    expect(screen.getByText("#RRGGBB").tagName).toBe("CODE");
  });

  it("filters by title and body via search (case-insensitive)", () => {
    render(<HelpPanel topics={topics} />);
    fireEvent.change(screen.getByLabelText("ヘルプを検索"), {
      target: { value: "CTRL-N" },
    });
    expect(screen.getByText("キーバインド")).toBeTruthy();
    expect(screen.queryByText("repos.conf と org の色")).toBeNull();
  });

  it("auto-expands matching items during search and shows the body without clicking", () => {
    render(<HelpPanel topics={topics} />);
    fireEvent.change(screen.getByLabelText("ヘルプを検索"), {
      target: { value: "ctrl-n" },
    });
    expect(screen.getByText(/新規セッション/)).toBeTruthy();
  });

  it("shows the empty state when there are no matches", () => {
    render(<HelpPanel topics={topics} />);
    fireEvent.change(screen.getByLabelText("ヘルプを検索"), {
      target: { value: "存在しない語" },
    });
    expect(screen.getByText("該当するヘルプがありません")).toBeTruthy();
  });

  it("shows category headings and arranges each topic under it", () => {
    render(<HelpPanel topics={topics} categories={categories} />);
    const config = screen.getByRole("region", { name: "設定ファイル" });
    const general = screen.getByRole("region", { name: "全般" });
    expect(config.textContent).toContain("repos.conf と org の色");
    expect(config.textContent).not.toContain("キーバインド");
    expect(general.textContent).toContain("キーバインド");
  });

  it("search keeps only categories containing a matching topic", () => {
    render(<HelpPanel topics={topics} categories={categories} />);
    fireEvent.change(screen.getByLabelText("ヘルプを検索"), {
      target: { value: "Ctrl-N" },
    });
    expect(screen.getByText("全般")).toBeTruthy();
    expect(screen.queryByText("設定ファイル")).toBeNull();
  });

  it("can render with the default topics (content/*.md)", () => {
    render(<HelpPanel />);
    expect(screen.getByText("HELP")).toBeTruthy();
    // The seed repos.conf topic is included.
    expect(screen.getByText(/repos\.conf/)).toBeTruthy();
  });
});
