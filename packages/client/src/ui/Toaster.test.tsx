// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { Notification } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toaster, visibleToasts } from "./Toaster.js";

afterEach(cleanup);

function note(over: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    level: "info",
    title: "タイトル",
    body: null,
    createdAt: 1_700_000_000_000,
    sticky: false,
    dismissible: true,
    ...over,
  };
}

describe("visibleToasts", () => {
  it("sticky is shown while not hidden", () => {
    const list = [note({ id: "s", sticky: true })];
    expect(visibleToasts(list, new Set()).map((n) => n.id)).toEqual(["s"]);
  });
  it("sticky is hidden once closed", () => {
    const list = [note({ id: "s", sticky: true })];
    expect(visibleToasts(list, new Set(["s"]))).toEqual([]);
  });
  it("non-sticky is not shown when hidden", () => {
    const list = [note({ id: "t", sticky: false })];
    expect(visibleToasts(list, new Set(["t"]))).toEqual([]);
  });
  it("toast:false (e.g. errors with an ErrorDialog) does not toast", () => {
    const list = [note({ id: "e", level: "error", toast: false })];
    expect(visibleToasts(list, new Set())).toEqual([]);
  });
});

describe("Toaster", () => {
  it("renders nothing when there are zero notifications", () => {
    const { container } = render(<Toaster notifications={[]} />);
    expect(container.querySelector(".toaster")).toBeNull();
  });

  it("a sticky toast is shown and disappears in place via the close button", () => {
    render(
      <Toaster notifications={[note({ title: "再起動して", sticky: true })]} />,
    );
    expect(screen.getByText("再起動して")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText("再起動して")).toBeNull();
  });

  it("a non-sticky toast disappears in place via the close button", () => {
    render(<Toaster notifications={[note({ title: "一時通知" })]} />);
    expect(screen.getByText("一時通知")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText("一時通知")).toBeNull();
  });

  it("non-sticky auto-dismisses after autoHideMs elapses", () => {
    vi.useFakeTimers();
    try {
      render(
        <Toaster
          notifications={[note({ title: "自動消灯" })]}
          autoHideMs={100}
        />,
      );
      expect(screen.getByText("自動消灯")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(screen.queryByText("自動消灯")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
