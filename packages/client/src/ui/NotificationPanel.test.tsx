// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Notification } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationPanel, partitionBySeen } from "./NotificationPanel.js";

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

function renderPanel(
  props: Partial<Parameters<typeof NotificationPanel>[0]> = {},
) {
  return render(
    <NotificationPanel
      notifications={props.notifications ?? []}
      seenIds={props.seenIds ?? []}
      onDismiss={props.onDismiss ?? (() => undefined)}
      onMarkRead={props.onMarkRead ?? (() => undefined)}
      inactive={props.inactive}
    />,
  );
}

describe("partitionBySeen", () => {
  it("splits into unread/read by the seen set", () => {
    const list = [note({ id: "a" }), note({ id: "b" }), note({ id: "c" })];
    const { unread, read } = partitionBySeen(list, ["b"]);
    expect(unread.map((n) => n.id)).toEqual(["a", "c"]);
    expect(read.map((n) => n.id)).toEqual(["b"]);
  });
});

describe("NotificationPanel", () => {
  it("shows the unread tab empty when there are no unread notifications", () => {
    renderPanel();
    expect(screen.getByText("未読の通知はありません")).toBeTruthy();
  });

  it("renders the NOTIFICATION header with the shared panel-header", () => {
    renderPanel();
    const title = screen.getByText("NOTIFICATION");
    expect(title.closest("header")?.className).toBe("panel-header");
  });

  it("places the header outside the scroll container (directly under root) so it stays fixed", () => {
    const { container } = renderPanel({ notifications: [note()] });
    const root = container.querySelector(".notification-panel");
    expect(root?.querySelector(":scope > .panel-header")).toBeTruthy();
    expect(root?.querySelector(":scope > .notification-scroll")).toBeTruthy();
    expect(
      root?.querySelector(".notification-scroll .panel-header"),
    ).toBeNull();
  });

  it("renders the title and body", () => {
    renderPanel({
      notifications: [note({ title: "設定変更", body: "再起動して" })],
    });
    expect(screen.getByText("設定変更")).toBeTruthy();
    expect(screen.getByText("再起動して")).toBeTruthy();
  });

  it("renders ✕ for a dismissible notification and calls onDismiss(id) on click", () => {
    const onDismiss = vi.fn();
    renderPanel({
      notifications: [note({ id: "abc", dismissible: true })],
      onDismiss,
    });
    fireEvent.click(screen.getByRole("button", { name: "通知を消す" }));
    expect(onDismiss).toHaveBeenCalledWith("abc");
  });

  it("does not render ✕ for a non-dismissible notification (sticky, restart required)", () => {
    renderPanel({
      notifications: [note({ sticky: true, dismissible: false })],
    });
    expect(screen.queryByRole("button", { name: "通知を消す" })).toBeNull();
  });

  it("shows only unread on the unread tab and only read on the read tab", () => {
    renderPanel({
      notifications: [
        note({ id: "u", title: "未読通知" }),
        note({ id: "r", title: "既読通知" }),
      ],
      seenIds: ["r"],
    });
    // The unread tab is the default
    expect(screen.getByText("未読通知")).toBeTruthy();
    expect(screen.queryByText("既読通知")).toBeNull();
    // Switch to the read tab
    fireEvent.click(screen.getByRole("tab", { name: /既読/ }));
    expect(screen.getByText("既読通知")).toBeTruthy();
    expect(screen.queryByText("未読通知")).toBeNull();
  });

  it("shows the count on each tab", () => {
    renderPanel({
      notifications: [note({ id: "a" }), note({ id: "b" }), note({ id: "c" })],
      seenIds: ["c"],
    });
    expect(screen.getByRole("tab", { name: "未読 (2)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "既読 (1)" })).toBeTruthy();
  });

  it("calls onMarkRead(id) on double-clicking an item", () => {
    const onMarkRead = vi.fn();
    renderPanel({
      notifications: [note({ id: "x", title: "既読にする" })],
      onMarkRead,
    });
    fireEvent.doubleClick(screen.getByText("既読にする"));
    expect(onMarkRead).toHaveBeenCalledWith("x");
  });
});
