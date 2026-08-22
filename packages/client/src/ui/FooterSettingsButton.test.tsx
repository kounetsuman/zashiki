// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FooterSettingsButton } from "./FooterSettingsButton.js";

afterEach(cleanup);

describe("FooterSettingsButton", () => {
  it("renders a settings button that is not a radio", () => {
    render(<FooterSettingsButton onOpen={() => undefined} />);
    const btn = screen.getByRole("button", { name: "設定" });
    expect(btn.getAttribute("role")).toBeNull();
  });

  it("calls onOpen on click", () => {
    const onOpen = vi.fn();
    render(<FooterSettingsButton onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
