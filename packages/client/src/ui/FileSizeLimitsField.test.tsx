// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_FILE_SIZE_LIMITS } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSizeLimitsField } from "./FileSizeLimitsField.js";

afterEach(cleanup);

const MIB = 1024 * 1024;
const saveButton = () => screen.getByRole("button", { name: "保存" });
const inputs = () => screen.getAllByRole("spinbutton") as HTMLInputElement[];
const confirmInput = () => inputs()[0] as HTMLInputElement;
const maxInput = () => inputs()[1] as HTMLInputElement;

describe("FileSizeLimitsField", () => {
  it("shows both sizes in MB", () => {
    render(
      <FileSizeLimitsField value={DEFAULT_FILE_SIZE_LIMITS} onSave={vi.fn()} />,
    );
    expect(confirmInput().value).toBe("20");
    expect(maxInput().value).toBe("200");
  });

  it("keeps Save disabled until an edit, then sends both sizes in bytes", () => {
    const onSave = vi.fn();
    render(
      <FileSizeLimitsField value={DEFAULT_FILE_SIZE_LIMITS} onSave={onSave} />,
    );
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(confirmInput(), { target: { value: "50" } });
    fireEvent.change(maxInput(), { target: { value: "500" } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      confirmBytes: 50 * MIB,
      maxBytes: 500 * MIB,
    });
  });

  it("holds each size to whole MB within its range", () => {
    render(
      <FileSizeLimitsField value={DEFAULT_FILE_SIZE_LIMITS} onSave={vi.fn()} />,
    );
    fireEvent.change(maxInput(), { target: { value: "5000" } });
    expect(maxInput().value).toBe("1024");
    fireEvent.change(confirmInput(), { target: { value: "0" } });
    expect(confirmInput().value).toBe("20");
    fireEvent.change(confirmInput(), { target: { value: "2000" } });
    expect(confirmInput().value).toBe("1024");
  });

  it("leaves the confirmation size alone while the maximum is typed digit by digit", () => {
    const onSave = vi.fn();
    render(
      <FileSizeLimitsField value={DEFAULT_FILE_SIZE_LIMITS} onSave={onSave} />,
    );
    for (const typed of ["5", "50", "500"]) {
      fireEvent.change(maxInput(), { target: { value: typed } });
    }
    expect(confirmInput().value).toBe("20");
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      confirmBytes: 20 * MIB,
      maxBytes: 500 * MIB,
    });
  });

  it("saves a confirmation size above the maximum as the maximum", () => {
    const onSave = vi.fn();
    render(
      <FileSizeLimitsField value={DEFAULT_FILE_SIZE_LIMITS} onSave={onSave} />,
    );
    fireEvent.change(maxInput(), { target: { value: "10" } });
    expect(confirmInput().value).toBe("20");
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      confirmBytes: 10 * MIB,
      maxBytes: 10 * MIB,
    });
    expect(confirmInput().value).toBe("10");
  });

  it("follows the saved sizes when they change elsewhere", () => {
    const { rerender } = render(
      <FileSizeLimitsField value={DEFAULT_FILE_SIZE_LIMITS} onSave={vi.fn()} />,
    );
    rerender(
      <FileSizeLimitsField
        value={{ confirmBytes: 8 * MIB, maxBytes: 64 * MIB }}
        onSave={vi.fn()}
      />,
    );
    expect(confirmInput().value).toBe("8");
    expect(maxInput().value).toBe("64");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("keeps its inputs at 16px on touch screens so iOS does not zoom in", () => {
    const css = readFileSync(
      join(import.meta.dirname, "SettingsModal.css"),
      "utf8",
    );
    expect(css).toMatch(
      /@media \(any-pointer: coarse\) \{\s*\.file-size-limits-input \{\s*font-size: 16px;/,
    );
  });
});
