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

function open(
  links: SessionLink[] = LINKS,
  onCopyLink = vi.fn(),
  onLinksClosed = vi.fn(),
  onLinksOpenChange = vi.fn(),
) {
  render(
    <SessionStatusFooter
      usage={null}
      links={links}
      onCopyLink={onCopyLink}
      onLinksClosed={onLinksClosed}
      onLinksOpenChange={onLinksOpenChange}
    />,
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

  it("hands focus back to the terminal however it closes", () => {
    const closeBy = [
      () => fireEvent.click(screen.getByRole("button", { name: "閉じる" })),
      () => fireEvent.click(linkButton()),
      () => fireEvent.keyDown(popover() as HTMLElement, { key: "Escape" }),
    ];
    for (const close of closeBy) {
      const onLinksClosed = vi.fn();
      open(LINKS, vi.fn(), onLinksClosed);
      close();
      expect(popover()).toBeNull();
      expect(onLinksClosed).toHaveBeenCalledOnce();
      cleanup();
    }
  });
});

describe("session links open state", () => {
  it("reports opening and closing", () => {
    const onLinksOpenChange = vi.fn();
    open(LINKS, vi.fn(), vi.fn(), onLinksOpenChange);
    expect(onLinksOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(linkButton());
    expect(onLinksOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("reports closed when the footer goes away while it is open", () => {
    const onLinksOpenChange = vi.fn();
    open(LINKS, vi.fn(), vi.fn(), onLinksOpenChange);
    cleanup();
    expect(onLinksOpenChange).toHaveBeenLastCalledWith(false);
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
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  it("takes focus when it opens, so Escape reaches it without a click", () => {
    open();
    expect(document.activeElement).toBe(popover());
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(popover()).toBeNull();
  });

  it("pulls focus back inside when clicked while focus is elsewhere", () => {
    const outside = document.createElement("textarea");
    document.body.append(outside);
    try {
      open();
      outside.focus();
      const chip = screen.getByRole("button", { name: /^PR/ });
      const pressed = fireEvent.mouseDown(chip);
      expect(pressed).toBe(false);
      expect(document.activeElement).toBe(popover());
      fireEvent.keyDown(outside, { key: "Escape" });
      expect(popover()).not.toBeNull();
    } finally {
      outside.remove();
    }
  });

  it("leaves focus on a control inside it that already has it", () => {
    open();
    const tab = screen.getByRole("tab", { name: /会話に出たもの/ });
    tab.focus();
    fireEvent.mouseDown(screen.getByRole("button", { name: /^PR/ }));
    expect(document.activeElement).toBe(tab);
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

  it("shows a GitHub link's real title and labels its icon with the state", () => {
    open([
      {
        ...PR_12,
        github: {
          owner: "o",
          repo: "r",
          number: 12,
          title: "Add links",
          state: "merged",
        },
      },
    ]);
    const dialog = popover() as HTMLElement;
    const row = within(dialog)
      .getByText("Add links")
      .closest("li") as HTMLElement;
    expect(within(row).getByText("o/r #12")).toBeTruthy();
    const icon = within(row).getByRole("img", { name: "マージ済み" });
    expect(icon.style.color).toBe("rgb(198, 120, 221)");
  });

  it("leaves the icon unlabelled and neutral while the state is unknown", () => {
    open([PR_12]);
    const dialog = popover() as HTMLElement;
    expect(within(dialog).queryByRole("img")).toBeNull();
    const icon = dialog.querySelector("svg.sl-row-icon") as SVGElement;
    expect(icon.getAttribute("style")).toBeNull();
  });

  const FAVICON_LINK: SessionLink = {
    url: "https://docs.example.com/guide",
    tab: "conversation",
    kind: "other",
    source: "assistant",
    pageTitle: "The Guide",
    faviconOrigin: "https://docs.example.com",
  };

  const faviconUrl = (origin: string) => `/favicon?origin=${origin}`;

  function openWithFavicons(links: SessionLink[]) {
    render(
      <SessionStatusFooter
        usage={null}
        links={links}
        faviconUrl={faviconUrl}
      />,
    );
    fireEvent.click(linkButton());
    return popover() as HTMLElement;
  }

  it("shows another site's page title and its favicon", () => {
    const dialog = openWithFavicons([FAVICON_LINK]);
    const row = within(dialog)
      .getByText("The Guide")
      .closest("li") as HTMLElement;
    const img = row.querySelector("img.sl-row-icon") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(
      "/favicon?origin=https://docs.example.com",
    );
    expect(img.width).toBe(16);
    expect(img.alt).toBe("");
    expect(within(row).queryByText("public")).toBeNull();
  });

  it("falls back to the generic icon when the favicon fails to load", () => {
    const dialog = openWithFavicons([FAVICON_LINK]);
    fireEvent.error(dialog.querySelector("img.sl-row-icon") as HTMLElement);
    expect(dialog.querySelector("img")).toBeNull();
    expect(within(dialog).getByText("public")).toBeTruthy();
  });

  it("shows the generic icon while no favicon is offered", () => {
    const dialog = openWithFavicons([
      { ...FAVICON_LINK, faviconOrigin: undefined },
    ]);
    expect(dialog.querySelector("img")).toBeNull();
    expect(within(dialog).getByText("public")).toBeTruthy();
  });

  it("tries a failed favicon again when a later poll or a new origin brings it", () => {
    const { rerender } = render(
      <SessionStatusFooter
        usage={null}
        links={[FAVICON_LINK]}
        faviconUrl={faviconUrl}
      />,
    );
    fireEvent.click(linkButton());
    const dialog = popover() as HTMLElement;
    fireEvent.error(dialog.querySelector("img.sl-row-icon") as HTMLElement);
    expect(dialog.querySelector("img")).toBeNull();

    rerender(
      <SessionStatusFooter
        usage={null}
        links={[{ ...FAVICON_LINK }]}
        faviconUrl={faviconUrl}
      />,
    );
    expect(dialog.querySelector("img")).not.toBeNull();

    fireEvent.error(dialog.querySelector("img.sl-row-icon") as HTMLElement);
    rerender(
      <SessionStatusFooter
        usage={null}
        links={[{ ...FAVICON_LINK, faviconOrigin: "https://example.net" }]}
        faviconUrl={faviconUrl}
      />,
    );
    expect(
      (
        dialog.querySelector("img.sl-row-icon") as HTMLImageElement
      ).getAttribute("src"),
    ).toBe("/favicon?origin=https://example.net");
  });
});
