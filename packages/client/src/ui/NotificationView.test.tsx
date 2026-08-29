// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { Notification } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationView, partitionBySeen } from "./NotificationView.js";

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

function renderView(
  props: Partial<Parameters<typeof NotificationView>[0]> = {},
) {
  return render(
    <NotificationView
      notifications={props.notifications ?? []}
      seenIds={props.seenIds ?? []}
      onMarkRead={props.onMarkRead ?? (() => undefined)}
      onDelete={props.onDelete ?? (() => undefined)}
      title={props.title}
      dataView={props.dataView}
    />,
  );
}

function confirmDelete(): void {
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
}

describe("partitionBySeen", () => {
  it("splits into unread/read by the seen set", () => {
    const list = [note({ id: "a" }), note({ id: "b" }), note({ id: "c" })];
    const { unread, read } = partitionBySeen(list, ["b"]);
    expect(unread.map((n) => n.id)).toEqual(["a", "c"]);
    expect(read.map((n) => n.id)).toEqual(["b"]);
  });
});

describe("NotificationView", () => {
  it("shows the unread tab empty when there are no unread notifications", () => {
    renderView();
    expect(screen.getByText("未読の通知はありません")).toBeTruthy();
  });

  it("renders the NOTIFICATION header with the shared view-header", () => {
    renderView();
    const title = screen.getByText("NOTIFICATION");
    expect(title.closest("header")?.className).toBe("view-header");
  });

  it("renders a custom caption and data-view when reused as the ACTIVITY view", () => {
    const { container } = renderView({
      title: "ACTIVITY",
      dataView: "activity",
    });
    expect(screen.getByText("ACTIVITY")).toBeTruthy();
    expect(container.querySelector('[data-view="activity"]')).toBeTruthy();
  });

  it("renders the title and body", () => {
    renderView({
      notifications: [note({ title: "設定変更", body: "再起動して" })],
    });
    expect(screen.getByText("設定変更")).toBeTruthy();
    expect(screen.getByText("再起動して")).toBeTruthy();
  });

  it("marks an unread item read via its button and on double-click, and never deletes it", () => {
    const onMarkRead = vi.fn();
    const onDelete = vi.fn();
    renderView({
      notifications: [note({ id: "u", title: "未読通知" })],
      onMarkRead,
      onDelete,
    });
    fireEvent.click(screen.getByRole("button", { name: "既読にする" }));
    expect(onMarkRead).toHaveBeenCalledWith(["u"]);
    fireEvent.doubleClick(screen.getByText("未読通知"));
    expect(onMarkRead).toHaveBeenCalledTimes(2);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
  });

  it("bulk-marks checked unread items read via the tab-bar action", () => {
    const onMarkRead = vi.fn();
    renderView({
      notifications: [
        note({ id: "a", title: "未読A" }),
        note({ id: "b", title: "未読B" }),
        note({ id: "c", title: "未読C" }),
      ],
      onMarkRead,
    });
    const checks = screen.getAllByRole("checkbox", { name: "既読対象に選択" });
    for (const [i, check] of checks.entries())
      if (i !== 1) fireEvent.click(check);
    fireEvent.click(
      screen.getByRole("button", { name: "選択した通知を既読にする" }),
    );
    expect(onMarkRead).toHaveBeenCalledWith(["a", "c"]);
  });

  it("select-all checks every unread item and bulk-marks them read", () => {
    const onMarkRead = vi.fn();
    renderView({
      notifications: [note({ id: "a" }), note({ id: "b" })],
      onMarkRead,
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "すべて選択" }));
    for (const check of screen.getAllByRole("checkbox", {
      name: "既読対象に選択",
    }))
      expect((check as HTMLInputElement).checked).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "選択した通知を既読にする" }),
    );
    expect(onMarkRead).toHaveBeenCalledWith(["a", "b"]);
  });

  it("select-all on the read tab selects only dismissible items for deletion", () => {
    const onDelete = vi.fn();
    renderView({
      notifications: [
        note({ id: "a", title: "既読A" }),
        note({ id: "sys", sticky: true, dismissible: false }),
        note({ id: "b", title: "既読B" }),
      ],
      seenIds: ["a", "sys", "b"],
      onDelete,
    });
    fireEvent.click(screen.getByRole("tab", { name: /既読/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "すべて選択" }));
    fireEvent.click(screen.getByRole("button", { name: "選択した通知を削除" }));
    confirmDelete();
    expect(onDelete).toHaveBeenCalledWith(["a", "b"]);
  });

  it("deletes a read item only after confirming, then calls onDelete(id)", () => {
    const onDelete = vi.fn();
    renderView({
      notifications: [note({ id: "r", title: "既読通知" })],
      seenIds: ["r"],
      onDelete,
    });
    fireEvent.click(screen.getByRole("tab", { name: /既読/ }));
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    confirmDelete();
    expect(onDelete).toHaveBeenCalledWith(["r"]);
  });

  it("bulk-deletes checked read items via the tab-bar delete after confirming", () => {
    const onDelete = vi.fn();
    renderView({
      notifications: [
        note({ id: "a", title: "既読A" }),
        note({ id: "b", title: "既読B" }),
      ],
      seenIds: ["a", "b"],
      onDelete,
    });
    fireEvent.click(screen.getByRole("tab", { name: /既読/ }));
    for (const check of screen.getAllByRole("checkbox", {
      name: "削除対象に選択",
    }))
      fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "選択した通知を削除" }));
    confirmDelete();
    expect(onDelete).toHaveBeenCalledWith(["a", "b"]);
  });

  it("does not offer delete or checkbox for a non-dismissible read item", () => {
    renderView({
      notifications: [note({ id: "sys", sticky: true, dismissible: false })],
      seenIds: ["sys"],
    });
    fireEvent.click(screen.getByRole("tab", { name: /既読/ }));
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows only unread on the unread tab and only read on the read tab", () => {
    renderView({
      notifications: [
        note({ id: "u", title: "未読通知" }),
        note({ id: "r", title: "既読通知" }),
      ],
      seenIds: ["r"],
    });
    expect(screen.getByText("未読通知")).toBeTruthy();
    expect(screen.queryByText("既読通知")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /既読/ }));
    expect(screen.getByText("既読通知")).toBeTruthy();
    expect(screen.queryByText("未読通知")).toBeNull();
  });

  it("shows the count on each tab", () => {
    renderView({
      notifications: [note({ id: "a" }), note({ id: "b" }), note({ id: "c" })],
      seenIds: ["c"],
    });
    expect(screen.getByRole("tab", { name: "未読 (2)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "既読 (1)" })).toBeTruthy();
  });
});
