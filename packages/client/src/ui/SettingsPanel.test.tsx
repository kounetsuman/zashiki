// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "./SettingsPanel.js";

afterEach(cleanup);

describe("SettingsPanel", () => {
  it("reflects the current language in the dropdown and disables Save when unchanged", () => {
    render(<SettingsPanel language="ja" onSaveLanguage={() => {}} />);
    const select = screen.getByLabelText("表示言語") as HTMLSelectElement;
    expect(select.value).toBe("ja");
    const save = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("renders the ja / en options", () => {
    render(<SettingsPanel language="en" onSaveLanguage={() => {}} />);
    expect(screen.getByRole("option", { name: "日本語" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
  });

  it("shows the add-org entry only when onAddOrg is provided and calls it on click", () => {
    const onAddOrg = vi.fn();
    const { rerender } = render(
      <SettingsPanel language="ja" onSaveLanguage={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "組織を追加" })).toBeNull();
    rerender(
      <SettingsPanel
        language="ja"
        onSaveLanguage={() => {}}
        onAddOrg={onAddOrg}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "組織を追加" }));
    expect(onAddOrg).toHaveBeenCalled();
  });

  it("calls onSaveLanguage with the selected language after changing it and saving", () => {
    const onSaveLanguage = vi.fn();
    render(<SettingsPanel language="ja" onSaveLanguage={onSaveLanguage} />);
    fireEvent.change(screen.getByLabelText("表示言語"), {
      target: { value: "en" },
    });
    const save = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSaveLanguage).toHaveBeenCalledWith("en");
  });

  it("does not render the font-size controls when fontSize is omitted", () => {
    render(<SettingsPanel language="ja" onSaveLanguage={() => {}} />);
    expect(screen.queryByText("ターミナルの文字サイズ")).toBeNull();
  });

  it("shows the current font size and wires A- / A+ / reset", () => {
    const onIncreaseFontSize = vi.fn();
    const onDecreaseFontSize = vi.fn();
    const onResetFontSize = vi.fn();
    render(
      <SettingsPanel
        language="ja"
        onSaveLanguage={() => {}}
        fontSize={13}
        onIncreaseFontSize={onIncreaseFontSize}
        onDecreaseFontSize={onDecreaseFontSize}
        onResetFontSize={onResetFontSize}
      />,
    );
    expect(screen.getByText("13px")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "文字を大きく" }));
    fireEvent.click(screen.getByRole("button", { name: "文字を小さく" }));
    fireEvent.click(screen.getByRole("button", { name: "リセット" }));
    expect(onIncreaseFontSize).toHaveBeenCalledTimes(1);
    expect(onDecreaseFontSize).toHaveBeenCalledTimes(1);
    expect(onResetFontSize).toHaveBeenCalledTimes(1);
  });

  it("disables A+ at the maximum and A- at the minimum", () => {
    render(
      <SettingsPanel
        language="ja"
        onSaveLanguage={() => {}}
        fontSize={32}
        canIncreaseFontSize={false}
        canDecreaseFontSize={true}
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "文字を大きく",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "文字を小さく",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("disables Reset when canResetFontSize is false", () => {
    render(
      <SettingsPanel
        language="ja"
        onSaveLanguage={() => {}}
        fontSize={13}
        canResetFontSize={false}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "リセット" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("labels the font-size controls as a group", () => {
    render(
      <SettingsPanel language="ja" onSaveLanguage={() => {}} fontSize={13} />,
    );
    expect(
      screen.getByRole("group", { name: "ターミナルの文字サイズ" }),
    ).toBeTruthy();
  });
});
