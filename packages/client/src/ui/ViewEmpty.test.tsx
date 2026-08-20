// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ViewEmpty } from "./ViewEmpty.js";

afterEach(cleanup);

describe("ViewEmpty", () => {
  it("renders the message with the shared view-empty class", () => {
    render(<ViewEmpty>通知はありません</ViewEmpty>);
    const el = screen.getByText("通知はありません");
    expect(el.className).toBe("view-empty");
  });

  it("lets each view specify the message freely (renders children as-is)", () => {
    render(<ViewEmpty>結果なし</ViewEmpty>);
    expect(screen.getByText("結果なし")).toBeTruthy();
  });
});
