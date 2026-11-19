// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_STALL_RULES } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StallRulesField } from "./StallRulesField.js";

afterEach(cleanup);

const saveButton = () => screen.getByRole("button", { name: "保存" });

describe("StallRulesField", () => {
  it("edits the limits and a per-command override, then saves the whole rules", () => {
    const onSave = vi.fn();
    render(<StallRulesField value={DEFAULT_STALL_RULES} onSave={onSave} />);
    expect(saveButton()).toHaveProperty("disabled", true);

    const [launch] = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(launch as HTMLInputElement, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "コマンドを追加" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "コマンドに含む文字列" }),
      {
        target: { value: "make ci" },
      },
    );
    const overrideMinutes = screen.getAllByRole("spinbutton").at(-1);
    fireEvent.change(overrideMinutes as HTMLInputElement, {
      target: { value: "25" },
    });
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith({
      ...DEFAULT_STALL_RULES,
      launchLimitMin: 30,
      overrides: [{ match: "make ci", launchLimitMin: 25 }],
    });
  });

  it("ignores a value below 1 and removes an override", () => {
    const onSave = vi.fn();
    render(
      <StallRulesField
        value={{
          ...DEFAULT_STALL_RULES,
          overrides: [{ match: "make ci", launchLimitMin: 25 }],
        }}
        onSave={onSave}
      />,
    );
    const [launch] = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(launch as HTMLInputElement, { target: { value: "0" } });
    expect(launch?.value).toBe("20");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith(DEFAULT_STALL_RULES);
  });

  it("keeps its inputs at 16px on touch screens so iOS does not zoom in", () => {
    const css = readFileSync(
      join(import.meta.dirname, "SettingsModal.css"),
      "utf8",
    );
    expect(css).toMatch(
      /@media \(any-pointer: coarse\) \{\s*\.stall-rules-input \{\s*font-size: 16px;/,
    );
  });
});
