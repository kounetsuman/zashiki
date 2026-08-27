// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WelcomeOnboardingModal } from "./WelcomeOnboardingModal.js";

afterEach(cleanup);

describe("WelcomeOnboardingModal", () => {
  it("continues into setup via Get started", () => {
    const onStart = vi.fn();
    render(<WelcomeOnboardingModal onStart={onStart} onSkip={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(onStart).toHaveBeenCalled();
  });

  it("skips the flow via the Skip button", () => {
    const onSkip = vi.fn();
    render(<WelcomeOnboardingModal onStart={() => {}} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("skips the flow on Escape and a backdrop click", () => {
    const onSkip = vi.fn();
    const { container } = render(
      <WelcomeOnboardingModal onStart={() => {}} onSkip={onSkip} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    const backdrop = container.querySelector(
      ".onboarding-backdrop",
    ) as HTMLElement;
    fireEvent.click(backdrop);
    expect(onSkip).toHaveBeenCalledTimes(2);
  });
});
