// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { SessionEvent } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStatsModal } from "./SessionStatsModal.js";

afterEach(cleanup);

const EVENTS: SessionEvent[] = [
  { at: 1, kind: "prompt", text: "fix the build" },
  {
    at: 2,
    kind: "read",
    tool: "Read",
    text: "src/a.ts",
    target: "src/a.ts",
    outcome: "ok",
  },
  {
    at: 3,
    kind: "command",
    tool: "Bash",
    text: "pnpm test",
    target: "pnpm test",
    outcome: "failed",
    durationMs: 1_500,
  },
  {
    at: 4,
    kind: "command",
    tool: "Bash",
    text: "git push -f",
    target: "git push",
    outcome: "denied",
    deniedBy: "hook",
  },
  {
    at: 5,
    kind: "web",
    tool: "WebFetch",
    text: "https://docs.rs/",
    domains: ["docs.rs"],
    outcome: "ok",
  },
  {
    at: 6,
    kind: "compaction",
    text: "auto",
    preTokens: 162_000,
    postTokens: 31_000,
  },
];

function renderModal(
  events: SessionEvent[] | null = EVENTS,
  onOpenLinks = vi.fn(),
) {
  render(
    <SessionStatsModal
      cockpitTerminalId="t1"
      sessionTitle="my session"
      events={events}
      onOpenLinks={onOpenLinks}
      onClose={() => undefined}
    />,
  );
  return { onOpenLinks };
}

const timelineTexts = () =>
  [...document.querySelectorAll(".sst-event .sst-text")].map(
    (el) => el.textContent,
  );

describe("SessionStatsModal", () => {
  it("opens on the Summary with the four groups", () => {
    renderModal();
    expect(screen.getByText("my session")).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "サマリー" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    for (const name of ["ファイル", "コマンド", "外部アクセス", "拒否"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
    const commands = screen.getByRole("region", { name: "コマンド" });
    expect(
      within(commands).getByText("2 コマンド · 実行 2 · 失敗 1"),
    ).toBeTruthy();
  });

  it("switches to the Timeline with every event in order", () => {
    renderModal();
    fireEvent.click(screen.getByRole("radio", { name: "タイムライン" }));
    expect(timelineTexts()).toEqual([
      "fix the build",
      "src/a.ts",
      "pnpm test",
      "git push -f",
      "https://docs.rs/",
    ]);
    expect(
      screen.getByText("コンテキスト圧縮 · 162.0k → 31.0k トークン"),
    ).toBeTruthy();
  });

  it("mutes an interrupted call instead of flagging it", () => {
    renderModal([
      {
        at: 1,
        kind: "command",
        tool: "Bash",
        text: "sleep 99",
        target: "sleep",
        outcome: "interrupted",
      },
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "タイムライン" }));
    const row = document.querySelector(".sst-event") as HTMLElement;
    expect(row.classList.contains("sst-event-interrupted")).toBe(true);
    expect(row.classList.contains("sst-event-flagged")).toBe(false);
    expect(row.querySelector(".sst-meta")?.textContent).toBe("中断");
  });

  it("leaves out a compaction's missing token count", () => {
    renderModal([
      { at: 1, kind: "compaction", text: "auto", preTokens: 162_000 },
      { at: 2, kind: "compaction", text: "auto", postTokens: 31_000 },
      { at: 3, kind: "compaction", text: "auto" },
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "タイムライン" }));
    expect(
      [...document.querySelectorAll(".sst-divider")].map(
        (el) => el.textContent,
      ),
    ).toEqual([
      "コンテキスト圧縮 · 162.0k トークンから",
      "コンテキスト圧縮 · 31.0k トークンへ",
      "コンテキスト圧縮",
    ]);
  });

  it("highlights failed and denied rows only", () => {
    renderModal();
    fireEvent.click(screen.getByRole("radio", { name: "タイムライン" }));
    const flagged = [
      ...document.querySelectorAll(".sst-event-flagged .sst-text"),
    ].map((el) => el.textContent);
    expect(flagged).toEqual(["pnpm test", "git push -f"]);
  });

  it("a Summary row opens the Timeline narrowed to it, and its chip clears the narrowing", () => {
    renderModal();
    const files = screen.getByRole("region", { name: "ファイル" });
    fireEvent.click(within(files).getByRole("button", { name: /src\/a\.ts/ }));
    expect(
      screen
        .getByRole("radio", { name: "タイムライン" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(timelineTexts()).toEqual(["src/a.ts"]);

    fireEvent.click(
      screen.getByRole("button", { name: "絞り込みを外す: src/a.ts" }),
    );
    expect(
      screen.queryByRole("button", { name: "絞り込みを外す: src/a.ts" }),
    ).toBeNull();
    expect(timelineTexts()).toEqual(["src/a.ts"]);
    expect(
      screen
        .getByRole("button", { name: /^ファイル/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("a filter chip narrows the Timeline to its group", () => {
    renderModal();
    fireEvent.click(screen.getByRole("radio", { name: "タイムライン" }));
    fireEvent.click(screen.getByRole("button", { name: /^拒否/ }));
    expect(timelineTexts()).toEqual(["git push -f"]);
  });

  it("starts over on the Summary when another Cockpit Terminal becomes active", () => {
    const modal = (id: string) => (
      <SessionStatsModal
        cockpitTerminalId={id}
        sessionTitle={id}
        events={EVENTS}
        onOpenLinks={() => undefined}
        onClose={() => undefined}
      />
    );
    const { rerender } = render(modal("t1"));
    const files = screen.getByRole("region", { name: "ファイル" });
    fireEvent.click(within(files).getByRole("button", { name: /src\/a\.ts/ }));
    rerender(modal("t2"));
    expect(
      screen
        .getByRole("radio", { name: "サマリー" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "タイムライン" }));
    expect(
      screen.queryByRole("button", { name: "絞り込みを外す: src/a.ts" }),
    ).toBeNull();
  });

  it("the External card links to the links popover", () => {
    const { onOpenLinks } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "すべてのリンク →" }));
    expect(onOpenLinks).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state without events and a loading state before the first answer", () => {
    renderModal([]);
    expect(
      screen.getByText("この Claude Session ではまだ何も起きていません"),
    ).toBeTruthy();
    cleanup();
    renderModal(null);
    expect(screen.getByText("読み込み中…")).toBeTruthy();
  });
});
