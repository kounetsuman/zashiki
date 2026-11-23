// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CockpitTerminalInfo } from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IdleCockpitTerminalRow } from "../lib/idle-cockpit-terminals.js";
import { IdleCockpitTerminalGroup } from "./IdleCockpitTerminalGroup.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12);

const row = (id: string, days: number): IdleCockpitTerminalRow => ({
  terminal: {
    cockpitTerminalId: id,
    name: id,
    org: "wonder",
    repo: "repo",
    state: "idle",
    title: null,
    active: false,
  } satisfies CockpitTerminalInfo,
  title: `title-${id}`,
  lastActivityAt: NOW - days * DAY,
});

function renderGroup(
  rows: IdleCockpitTerminalRow[],
  tail = vi.fn(async (_id: string) => ["first", "last line"]),
) {
  const onOpenCockpitTerminal = vi.fn();
  const onCloseCockpitTerminal = vi.fn();
  const utils = render(
    <IdleCockpitTerminalGroup
      rows={rows}
      api={{ tail }}
      orgColors={{ wonder: "#123456" }}
      onOpenCockpitTerminal={onOpenCockpitTerminal}
      onCloseCockpitTerminal={onCloseCockpitTerminal}
    />,
  );
  return { ...utils, tail, onOpenCockpitTerminal, onCloseCockpitTerminal };
}

const rowEl = (id: string) =>
  document.querySelector(`[data-cockpit-terminal-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("IdleCockpitTerminalGroup", () => {
  it("renders nothing while no terminal is idle", () => {
    const { container } = renderGroup([]);
    expect(container.innerHTML).toBe("");
  });

  it("heads the group with the count, expanded, and collapses it", () => {
    renderGroup([row("a", 9), row("b", 2)]);
    const header = screen.getByRole("button", { name: "放置されている端末 2" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(rowEl("a")).not.toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(rowEl("a")).toBeNull();
  });

  it("shows each row's org color, title and idle days, red from a week on", () => {
    renderGroup([row("a", 9), row("b", 2)]);
    const a = rowEl("a");
    expect(a.textContent).toContain("title-a");
    expect(a.textContent).toContain("9 日");
    expect(a.querySelector(".idle-cockpit-terminal-days")?.className).toContain(
      "is-red",
    );
    expect(
      (a.querySelector(".org-dot") as HTMLElement).style.backgroundColor,
    ).toBe("rgb(18, 52, 86)");
    expect(
      rowEl("b").querySelector(".idle-cockpit-terminal-days")?.className,
    ).toContain("is-amber");
  });

  it("opens the terminal from its title", () => {
    const { onOpenCockpitTerminal } = renderGroup([row("a", 1)]);
    fireEvent.click(screen.getByRole("button", { name: "title-a" }));
    expect(onOpenCockpitTerminal).toHaveBeenCalledWith("a");
  });

  it("the chevron shows the last lines of the screen, read only then", async () => {
    const { tail } = renderGroup([row("a", 1)]);
    expect(tail).not.toHaveBeenCalled();
    const chevron = screen.getByRole("button", {
      name: "title-a の画面を表示",
    });
    fireEvent.click(chevron);
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText(/last line/)).toBeTruthy();
    expect(tail).toHaveBeenCalledWith("a", expect.any(AbortSignal));
    fireEvent.click(chevron);
    expect(screen.queryByText(/last line/)).toBeNull();
  });

  it("says so when the screen cannot be read or is empty", async () => {
    renderGroup(
      [row("a", 1)],
      vi.fn(async () => {
        throw new Error("HTTP 404");
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "title-a の画面を表示" }),
    );
    expect(
      await screen.findByText("画面を読み取れませんでした。"),
    ).toBeTruthy();
    cleanup();
    renderGroup(
      [row("b", 1)],
      vi.fn(async () => []),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "title-b の画面を表示" }),
    );
    expect(await screen.findByText("画面は空です。")).toBeTruthy();
  });

  it("closes a terminal only after the inline confirmation", () => {
    const { onCloseCockpitTerminal } = renderGroup([row("a", 1), row("b", 2)]);
    fireEvent.click(screen.getByRole("button", { name: "title-a を閉じる" }));
    expect(onCloseCockpitTerminal).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "title-a を閉じる（確認）" }),
    );
    expect(onCloseCockpitTerminal).toHaveBeenCalledWith("a");
  });

  it("cancel or Escape backs out of a pending close", () => {
    const { onCloseCockpitTerminal } = renderGroup([row("a", 1)]);
    fireEvent.click(screen.getByRole("button", { name: "title-a を閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(
      screen.getByRole("button", { name: "title-a を閉じる" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "title-a を閉じる" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseCockpitTerminal).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "title-a を閉じる" }),
    ).toBeTruthy();
  });

  it("ignores an Escape something else already handled", () => {
    renderGroup([row("a", 1)]);
    fireEvent.click(screen.getByRole("button", { name: "title-a を閉じる" }));
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    handled.preventDefault();
    act(() => {
      window.dispatchEvent(handled);
    });
    expect(
      screen.getByRole("button", { name: "title-a を閉じる（確認）" }),
    ).toBeTruthy();
  });

  it("collapsing the group cancels a pending close", () => {
    const { onCloseCockpitTerminal } = renderGroup([row("a", 1)]);
    fireEvent.click(screen.getByRole("button", { name: "title-a を閉じる" }));
    const header = screen.getByRole("button", { name: "放置されている端末 1" });
    fireEvent.click(header);
    fireEvent.click(header);
    expect(onCloseCockpitTerminal).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "title-a を閉じる" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "title-a を閉じる（確認）" }),
    ).toBeNull();
  });
});
