// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_DASHBOARD_SETTINGS } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardSettingsField } from "./DashboardSettingsField.js";

afterEach(cleanup);

const saveButton = () => screen.getByRole("button", { name: "保存" });
const addressInput = () =>
  screen.getByLabelText("ダッシュボードのアドレス") as HTMLInputElement;

describe("DashboardSettingsField", () => {
  it("offers every moment and frequency the setting accepts", () => {
    render(
      <DashboardSettingsField
        value={DEFAULT_DASHBOARD_SETTINGS}
        onSave={() => {}}
      />,
    );
    const [showOn, frequency] = screen.getAllByRole(
      "combobox",
    ) as HTMLSelectElement[];
    expect(Array.from(showOn?.options ?? [], (o) => o.value)).toEqual([
      "launch",
      "wake",
      "both",
    ]);
    expect(Array.from(frequency?.options ?? [], (o) => o.value)).toEqual([
      "every_time",
      "once_per_day",
    ]);
  });

  it("keeps Save disabled until an edit, then sends the whole object", () => {
    const onSave = vi.fn();
    render(
      <DashboardSettingsField
        value={DEFAULT_DASHBOARD_SETTINGS}
        onSave={onSave}
      />,
    );
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(addressInput(), {
      target: { value: "https://dash.example/board" },
    });
    fireEvent.change(screen.getAllByRole("combobox")[0] as HTMLSelectElement, {
      target: { value: "both" },
    });
    fireEvent.change(screen.getAllByRole("combobox")[1] as HTMLSelectElement, {
      target: { value: "once_per_day" },
    });
    expect(saveButton().hasAttribute("disabled")).toBe(false);

    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      url: "https://dash.example/board",
      showOn: "both",
      frequency: "once_per_day",
    });
  });

  it("sends the address trimmed, so a stray space does not leave the field unsaved forever", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <DashboardSettingsField
        value={DEFAULT_DASHBOARD_SETTINGS}
        onSave={onSave}
      />,
    );
    fireEvent.change(addressInput(), {
      target: { value: "  https://dash.example/board  " },
    });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      ...DEFAULT_DASHBOARD_SETTINGS,
      url: "https://dash.example/board",
    });

    // The server echoes back the trimmed value it stored; Save must settle on it.
    rerender(
      <DashboardSettingsField
        value={{
          ...DEFAULT_DASHBOARD_SETTINGS,
          url: "https://dash.example/board",
        }}
        onSave={onSave}
      />,
    );
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("follows the persisted value when another client changes it", () => {
    const { rerender } = render(
      <DashboardSettingsField
        value={DEFAULT_DASHBOARD_SETTINGS}
        onSave={() => {}}
      />,
    );
    rerender(
      <DashboardSettingsField
        value={{
          url: "file:///Users/me/board.html",
          showOn: "wake",
          frequency: "once_per_day",
        }}
        onSave={() => {}}
      />,
    );
    expect(addressInput().value).toBe("file:///Users/me/board.html");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });
});
