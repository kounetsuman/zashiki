// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { SessionLink } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStatusFooter } from "./SessionStatusFooter.js";

afterEach(cleanup);

const PR_12: SessionLink = {
  url: "https://github.com/o/r/pull/12",
  tab: "conversation",
  kind: "pr",
  source: "user",
  github: { owner: "o", repo: "r", number: 12 },
};

const LINKS: SessionLink[] = [
  PR_12,
  {
    url: "https://github.com/o/r/issues/3",
    tab: "conversation",
    kind: "issue",
    source: "assistant",
    github: { owner: "o", repo: "r", number: 3 },
  },
  {
    url: "https://docs.example.com/guide",
    tab: "conversation",
    kind: "other",
    source: "assistant",
  },
  {
    url: "https://www.rust-lang.org/",
    tab: "ai_referenced",
    kind: "other",
    source: "WebSearch",
    title: "Rust Lang",
  },
];

function linkButton() {
  return screen.getByRole("button", { name: "このセッションのリンク" });
}

function popover() {
  return screen.queryByRole("dialog", { name: "このセッションのリンク" });
}

function open(links: SessionLink[] = LINKS, onCopyLink = vi.fn()) {
  render(
    <SessionStatusFooter usage={null} links={links} onCopyLink={onCopyLink} />,
  );
  fireEvent.click(linkButton());
  return onCopyLink;
}

describe("session links button", () => {
  it("shows how many distinct links the session has", () => {
    render(
      <SessionStatusFooter
        usage={null}
        links={[...LINKS, { ...PR_12, tab: "ai_referenced", source: "Bash" }]}
      />,
    );
    expect(within(linkButton()).getByText("4")).toBeTruthy();
  });

  it("toggles the popover and marks itself pressed while it is open", () => {
    open();
    expect(popover()).not.toBeNull();
    expect(linkButton().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(linkButton());
    expect(popover()).toBeNull();
    expect(linkButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes from the popover's close button", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(popover()).toBeNull();
  });
});

describe("SessionLinksPopover", () => {
  it("stays open on an outside click and on Escape outside it", () => {
    open();
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(popover()).not.toBeNull();
  });

  it("closes on Escape while focus is inside it, without passing Escape on", () => {
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    try {
      open();
      const tab = screen.getByRole("tab", { name: /会話に出たもの/ });
      tab.focus();
      fireEvent.keyDown(tab, { key: "Escape" });
      expect(popover()).toBeNull();
      expect(outer).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(linkButton());
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  it("opens on the conversation tab with links grouped PR, Issue, Other", () => {
    open();
    const dialog = popover() as HTMLElement;
    expect(
      screen
        .getByRole("tab", { name: /会話に出たもの/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    const groups = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(groups).toEqual(["Pull Request1", "Issue1", "その他1"]);
    expect(within(dialog).getByText("o/r #12")).toBeTruthy();
    expect(within(dialog).getAllByText("github.com/o/r")).toHaveLength(2);
    expect(within(dialog).getByText("docs.example.com/guide")).toBeTruthy();
    expect(within(dialog).getByText("あなた")).toBeTruthy();
    expect(within(dialog).getAllByText("Claude")).toHaveLength(2);
  });

  it("switches to the AI tab, showing the tool name and a known title", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: /AI が参照したもの/ }));
    const dialog = popover() as HTMLElement;
    expect(within(dialog).getByText("Rust Lang")).toBeTruthy();
    expect(within(dialog).getByText("WebSearch")).toBeTruthy();
    expect(within(dialog).queryByText("o/r #12")).toBeNull();
  });

  it("filters by kind and offers chips only for kinds that have links", () => {
    open();
    const chips = [
      ...(popover() as HTMLElement).querySelectorAll("button[aria-pressed]"),
    ].map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
    expect(chips).toEqual([
      ["すべて3", "true"],
      ["PR1", "false"],
      ["Issue1", "false"],
      ["その他1", "false"],
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Issue/ }));
    const dialog = popover() as HTMLElement;
    expect(within(dialog).getByText("o/r #3")).toBeTruthy();
    expect(within(dialog).queryByText("o/r #12")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /AI が参照したもの/ }));
    expect(screen.queryByRole("button", { name: /^PR/ })).toBeNull();
  });

  it("says so when the tab has no links", () => {
    open(LINKS.filter((l) => l.tab === "conversation"));
    fireEvent.click(screen.getByRole("tab", { name: /AI が参照したもの/ }));
    expect(
      screen.getByText("この会話にはまだリンクが出ていません"),
    ).toBeTruthy();
  });

  it("opens a row in the browser and copies its URL", () => {
    const onCopy = open();
    const dialog = popover() as HTMLElement;
    const row = within(dialog)
      .getByText("o/r #12")
      .closest("li") as HTMLElement;
    const opens = within(row).getAllByRole("link");
    expect(opens.map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/o/r/pull/12",
      "https://github.com/o/r/pull/12",
    ]);
    expect(opens.every((a) => a.getAttribute("target") === "_blank")).toBe(
      true,
    );
    fireEvent.click(
      within(row).getByRole("button", { name: "リンクをコピー" }),
    );
    expect(onCopy).toHaveBeenCalledWith("https://github.com/o/r/pull/12");
  });
});
