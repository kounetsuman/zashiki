// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Tooltip } from "./Tooltip.js";

afterEach(cleanup);

const trigger = (container: HTMLElement) =>
  container.querySelector(".ss-group") as HTMLElement;

describe("Tooltip", () => {
  it("shows the label on hover and removes it on leave", () => {
    const { container } = render(
      <Tooltip label="hello" className="ss-group">
        <span>x</span>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.mouseEnter(trigger(container));
    expect(screen.getByRole("tooltip").textContent).toBe("hello");

    fireEvent.mouseLeave(trigger(container));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("carries the label on aria-label, not a native title that stacks a second tooltip", () => {
    const { container } = render(
      <Tooltip label="hello" className="ss-group">
        <span>x</span>
      </Tooltip>,
    );
    expect(trigger(container).getAttribute("aria-label")).toBe("hello");
    expect(trigger(container).hasAttribute("title")).toBe(false);
  });

  it("keeps the tooltip visible across parent re-renders", () => {
    const { container, rerender } = render(
      <Tooltip label="hello" className="ss-group">
        <span>x</span>
      </Tooltip>,
    );
    fireEvent.mouseEnter(trigger(container));
    expect(screen.getByRole("tooltip")).toBeTruthy();

    rerender(
      <Tooltip label="hello" className="ss-group">
        <span>x</span>
      </Tooltip>,
    );
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
});
