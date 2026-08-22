// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_FOOTER_THRESHOLDS } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FooterThresholdsField } from "./FooterThresholdsField.js";

afterEach(cleanup);

const saveButton = () => screen.getByRole("button", { name: "保存" });

describe("FooterThresholdsField", () => {
  it("renders one toggle and one number input per configurable band", () => {
    render(
      <FooterThresholdsField
        value={DEFAULT_FOOTER_THRESHOLDS}
        onSave={() => {}}
      />,
    );
    // usage warn/high/crit + tokens warn/crit + elapsed crit = 6 bands.
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(6);
  });

  it("shows the current values, with elapsed edited in hours", () => {
    render(
      <FooterThresholdsField
        value={DEFAULT_FOOTER_THRESHOLDS}
        onSave={() => {}}
      />,
    );
    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(inputs[0]?.value).toBe("50"); // usage warn %
    expect(inputs[3]?.value).toBe("1500000"); // tokens warn
    expect(inputs[5]?.value).toBe("24"); // elapsed crit: 86_400_000ms = 24h
  });

  it("keeps Save disabled until an edit, then sends the whole object", () => {
    const onSave = vi.fn();
    render(
      <FooterThresholdsField
        value={DEFAULT_FOOTER_THRESHOLDS}
        onSave={onSave}
      />,
    );
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(inputs[2] as HTMLInputElement, {
      target: { value: "95" },
    }); // usage crit
    expect(saveButton().hasAttribute("disabled")).toBe(false);

    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]?.[0].usagePercent.crit.value).toBe(95);
  });

  it("stores the elapsed value back in milliseconds", () => {
    const onSave = vi.fn();
    render(
      <FooterThresholdsField
        value={DEFAULT_FOOTER_THRESHOLDS}
        onSave={onSave}
      />,
    );
    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(inputs[5] as HTMLInputElement, {
      target: { value: "12" },
    });
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0]?.[0].elapsedMs.crit.value).toBe(12 * 3_600_000);
  });

  it("toggling a band off is captured in the saved payload", () => {
    const onSave = vi.fn();
    render(
      <FooterThresholdsField
        value={DEFAULT_FOOTER_THRESHOLDS}
        onSave={onSave}
      />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(boxes[2] as HTMLInputElement); // usage crit off
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0]?.[0].usagePercent.crit.enabled).toBe(false);
  });
});
