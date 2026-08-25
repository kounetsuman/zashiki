// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountIndicator } from "./AccountIndicator.js";

afterEach(cleanup);

describe("AccountIndicator", () => {
  it("shows the email, or a not-signed-in label when absent", () => {
    const { rerender } = render(
      <AccountIndicator
        email="user@example.com"
        runningCount={0}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("user@example.com")).toBeTruthy();

    rerender(
      <AccountIndicator
        email={null}
        runningCount={0}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("未ログイン")).toBeTruthy();
  });

  it("carries the switch-account tooltip on the refresh button", () => {
    render(
      <AccountIndicator
        email="user@example.com"
        runningCount={0}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "更新" }).title).toBe(
      "アカウントを切り替えた場合、更新すると全てのセッションに反映されます",
    );
  });

  it("refreshes without a dialog when no sessions are running", () => {
    const onRefresh = vi.fn();
    render(
      <AccountIndicator
        email="user@example.com"
        runningCount={0}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirms before restarting when sessions are running", () => {
    const onRefresh = vi.fn();
    render(
      <AccountIndicator
        email="user@example.com"
        runningCount={2}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByText("再起動して反映"));
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
