// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FirstRunSetupWizard } from "./FirstRunSetupWizard.js";

afterEach(cleanup);

describe("FirstRunSetupWizard", () => {
  it("enables and dismisses via the action buttons", () => {
    const onEnable = vi.fn();
    const onDismiss = vi.fn();
    render(
      <FirstRunSetupWizard
        statusLineConflict={false}
        onEnable={onEnable}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "有効化" }));
    expect(onEnable).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "後で" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("shows the wrap notice only when a statusLine conflicts", () => {
    const { rerender } = render(
      <FirstRunSetupWizard
        statusLineConflict={false}
        onEnable={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.queryByText(
        "既存の statusLine は保持されます（ラップして表示を維持します）。",
      ),
    ).toBeNull();
    rerender(
      <FirstRunSetupWizard
        statusLineConflict={true}
        onEnable={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByText(
        "既存の statusLine は保持されます（ラップして表示を維持します）。",
      ),
    ).toBeTruthy();
  });

  it("stays open on Escape and a backdrop click (dismiss is button-only)", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <FirstRunSetupWizard
        statusLineConflict={false}
        onEnable={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    const backdrop = container.querySelector(
      ".onboarding-backdrop",
    ) as HTMLElement;
    fireEvent.click(backdrop);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
