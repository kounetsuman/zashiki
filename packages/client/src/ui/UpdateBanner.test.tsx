// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdateBanner } from "./UpdateBanner.js";

afterEach(cleanup);

describe("UpdateBanner", () => {
  it("renders nothing when no update is available", () => {
    const { container } = render(
      <UpdateBanner
        version={null}
        updating={false}
        onUpdate={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls onUpdate on click and names the version in the tooltip", () => {
    const onUpdate = vi.fn();
    render(
      <UpdateBanner version="0.2.0" updating={false} onUpdate={onUpdate} />,
    );
    const button = screen.getByRole("button");
    expect(button.getAttribute("title")).toContain("0.2.0");
    fireEvent.click(button);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner and is disabled while updating", () => {
    const onUpdate = vi.fn();
    render(
      <UpdateBanner version="0.2.0" updating={true} onUpdate={onUpdate} />,
    );
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".update-spin")).toBeTruthy();
    fireEvent.click(button);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
