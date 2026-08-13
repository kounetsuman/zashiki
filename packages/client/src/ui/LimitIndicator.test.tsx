// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LimitIndicator } from "./LimitIndicator.js";

afterEach(cleanup);

describe("LimitIndicator", () => {
  it("renders nothing when count is 0", () => {
    const { container } = render(<LimitIndicator count={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a warning with the count as an alert when count is positive", () => {
    render(<LimitIndicator count={3} />);
    const alert = screen.getByRole("alert");
    expect(alert.className).toBe("limit-indicator");
    expect(alert.textContent).toContain("3 セッション");
  });
});
