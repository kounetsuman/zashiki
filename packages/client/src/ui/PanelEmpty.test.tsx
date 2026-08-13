// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PanelEmpty } from "./PanelEmpty.js";

afterEach(cleanup);

describe("PanelEmpty", () => {
  it("renders the message with the shared panel-empty class", () => {
    render(<PanelEmpty>通知はありません</PanelEmpty>);
    const el = screen.getByText("通知はありません");
    expect(el.className).toBe("panel-empty");
  });

  it("lets each panel specify the message freely (renders children as-is)", () => {
    render(<PanelEmpty>結果なし</PanelEmpty>);
    expect(screen.getByText("結果なし")).toBeTruthy();
  });
});
