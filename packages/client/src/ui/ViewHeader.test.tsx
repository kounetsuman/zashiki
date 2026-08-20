// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ViewHeader } from "./ViewHeader.js";

afterEach(cleanup);

describe("ViewHeader", () => {
  it("renders the title with the shared view-header/view-title markup", () => {
    render(<ViewHeader title="SOURCE CONTROL" />);
    const title = screen.getByText("SOURCE CONTROL");
    expect(title.className).toBe("view-title");
    const header = title.closest("header");
    expect(header?.className).toBe("view-header");
  });

  it("renders the right-side action (children) after the title", () => {
    render(
      <ViewHeader title="SEARCH">
        <button type="button">action</button>
      </ViewHeader>,
    );
    expect(screen.getByRole("button", { name: "action" })).toBeTruthy();
  });

  it("appends className to view-header (for derived views)", () => {
    render(<ViewHeader title="SESSION" className="extra-view" />);
    const header = screen.getByText("SESSION").closest("header");
    expect(header?.className).toBe("view-header extra-view");
  });
});
