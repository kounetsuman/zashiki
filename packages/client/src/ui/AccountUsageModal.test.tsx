// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountUsageModal } from "./AccountUsageModal.js";

afterEach(cleanup);

describe("AccountUsageModal", () => {
  it("enables on click while opted out", () => {
    const onEnable = vi.fn();
    render(
      <AccountUsageModal
        enabled={false}
        runningCount={0}
        onEnable={onEnable}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText("有効化"));
    expect(onEnable).toHaveBeenCalledOnce();
  });

  it("hides the enable button and shows the resume note once opted in with running terminals", () => {
    render(
      <AccountUsageModal
        enabled
        runningCount={3}
        onEnable={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByText("有効化")).toBeNull();
    expect(screen.getByText(/3/)).toBeTruthy();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <AccountUsageModal
        enabled={false}
        runningCount={0}
        onEnable={() => undefined}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
