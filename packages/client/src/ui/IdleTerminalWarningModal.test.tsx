// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CockpitTerminalInfo } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type IdleTerminalRow,
  IdleTerminalWarningModal,
} from "./IdleTerminalWarningModal.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12);

const row = (id: string, days: number): IdleTerminalRow => ({
  terminal: {
    cockpitTerminalId: id,
    name: id,
    org: "org",
    repo: "repo",
    state: "idle",
    title: null,
    active: false,
  } satisfies CockpitTerminalInfo,
  title: `title-${id}`,
  lastActivityAt: NOW - days * DAY,
});

function renderModal(
  rows: IdleTerminalRow[],
  tail = vi.fn(async (_id: string) => ["first", "last line"]),
) {
  const onCloseTerminal = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <IdleTerminalWarningModal
      rows={rows}
      nowMs={NOW}
      api={{ tail }}
      onCloseTerminal={onCloseTerminal}
      onClose={onClose}
    />,
  );
  return { ...utils, tail, onCloseTerminal, onClose };
}

afterEach(cleanup);

describe("IdleTerminalWarningModal", () => {
  it("lists each idle terminal with how long it has been idle", () => {
    renderModal([row("a", 1), row("b", 3)]);
    expect(screen.getByText("title-a")).toBeTruthy();
    expect(screen.getByText("1 日放置")).toBeTruthy();
    expect(screen.getByText("3 日放置")).toBeTruthy();
  });

  it("expanding a row shows the last lines of its screen, read only then", async () => {
    const { tail } = renderModal([row("a", 1)]);
    expect(tail).not.toHaveBeenCalled();
    const toggle = screen.getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText(/last line/)).toBeTruthy();
    expect(tail).toHaveBeenCalledWith("a", expect.any(AbortSignal));
    fireEvent.click(toggle);
    expect(screen.queryByText(/last line/)).toBeNull();
  });

  it("says so when the screen cannot be read", async () => {
    renderModal(
      [row("a", 1)],
      vi.fn(async () => {
        throw new Error("HTTP 404");
      }),
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(
      await screen.findByText("画面を読み取れませんでした。"),
    ).toBeTruthy();
  });

  it("closes a terminal only after the inline confirmation", () => {
    const { onCloseTerminal } = renderModal([row("a", 1), row("b", 2)]);
    fireEvent.click(screen.getByRole("button", { name: "title-a を閉じる" }));
    expect(onCloseTerminal).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "title-a を閉じる（確認）" }),
    );
    expect(onCloseTerminal).toHaveBeenCalledWith("a");
  });

  it("cancelling the confirmation keeps the terminal", () => {
    const { onCloseTerminal } = renderModal([row("a", 1)]);
    fireEvent.click(screen.getByRole("button", { name: "title-a を閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCloseTerminal).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "title-a を閉じる" }),
    ).toBeTruthy();
  });
});
