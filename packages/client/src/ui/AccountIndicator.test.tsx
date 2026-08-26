// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountIndicator } from "./AccountIndicator.js";

afterEach(cleanup);

function renderIndicator(
  overrides: Partial<{
    email: string | null;
    runningCount: number;
    onRefresh: (restartSessions: boolean) => void;
    onLogin: () => void;
    onLogout: () => void;
  }> = {},
) {
  const props = {
    email: "user@example.com",
    runningCount: 0,
    onRefresh: vi.fn(),
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
  render(<AccountIndicator {...props} />);
  return props;
}

/** Opens the account menu by clicking the email button. */
function openMenu(email = "user@example.com"): void {
  fireEvent.click(screen.getByText(email));
}

describe("AccountIndicator", () => {
  it("shows the email, or a not-signed-in label when absent", () => {
    const { rerender } = render(
      <AccountIndicator
        email="user@example.com"
        runningCount={0}
        onRefresh={() => undefined}
        onLogin={() => undefined}
        onLogout={() => undefined}
      />,
    );
    expect(screen.getByText("user@example.com")).toBeTruthy();

    rerender(
      <AccountIndicator
        email={null}
        runningCount={0}
        onRefresh={() => undefined}
        onLogin={() => undefined}
        onLogout={() => undefined}
      />,
    );
    expect(screen.getByText("未ログイン")).toBeTruthy();
  });

  it("opens the menu only after clicking the email", () => {
    renderIndicator();
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("別のアカウントでログイン")).toBeTruthy();
  });

  it("starts login and closes the menu", () => {
    const { onLogin } = renderIndicator();
    openMenu();
    fireEvent.click(screen.getByText("別のアカウントでログイン"));
    expect(onLogin).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("signs out", () => {
    const { onLogout } = renderIndicator();
    openMenu();
    fireEvent.click(screen.getByText("ログアウト"));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("reloads without a dialog when no sessions are running", () => {
    const { onRefresh } = renderIndicator({ runningCount: 0 });
    openMenu();
    fireEvent.click(screen.getByText("アカウントを再読込"));
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirms before restarting when sessions are running", () => {
    const { onRefresh } = renderIndicator({ runningCount: 2 });
    openMenu();
    fireEvent.click(screen.getByText("アカウントを再読込"));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByText("再起動して反映"));
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
