// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PanelHeader } from "./PanelHeader.js";

afterEach(cleanup);

describe("PanelHeader", () => {
  it("renders the title with the shared panel-header/panel-title markup", () => {
    render(<PanelHeader title="SOURCE CONTROL" />);
    const title = screen.getByText("SOURCE CONTROL");
    expect(title.className).toBe("panel-title");
    const header = title.closest("header");
    expect(header?.className).toBe("panel-header");
  });

  it("renders the right-side action (children) after the title", () => {
    render(
      <PanelHeader title="SEARCH">
        <button type="button">action</button>
      </PanelHeader>,
    );
    expect(screen.getByRole("button", { name: "action" })).toBeTruthy();
  });

  it("appends className to panel-header (for derived panels)", () => {
    render(<PanelHeader title="SESSION" className="extra-panel" />);
    const header = screen.getByText("SESSION").closest("header");
    expect(header?.className).toBe("panel-header extra-panel");
  });
});
