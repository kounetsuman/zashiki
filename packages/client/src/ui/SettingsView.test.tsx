// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UpdateCheckResultMessage } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "./SettingsView.js";

afterEach(cleanup);

describe("SettingsView", () => {
  it("reflects the current language in the dropdown and disables Save when unchanged", () => {
    render(<SettingsView language="ja" onSaveLanguage={() => {}} />);
    const select = screen.getByLabelText("表示言語") as HTMLSelectElement;
    expect(select.value).toBe("ja");
    const save = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("renders the ja / en options", () => {
    render(<SettingsView language="en" onSaveLanguage={() => {}} />);
    expect(screen.getByRole("option", { name: "日本語" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
  });

  it("shows the add-org entry only when onAddOrg is provided and calls it on click", () => {
    const onAddOrg = vi.fn();
    const { rerender } = render(
      <SettingsView language="ja" onSaveLanguage={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "組織を追加" })).toBeNull();
    rerender(
      <SettingsView
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
    render(<SettingsView language="ja" onSaveLanguage={onSaveLanguage} />);
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
    render(<SettingsView language="ja" onSaveLanguage={() => {}} />);
    expect(screen.queryByText("ターミナルの文字サイズ")).toBeNull();
  });

  it("shows the current font size and wires A- / A+ / reset", () => {
    const onIncreaseFontSize = vi.fn();
    const onDecreaseFontSize = vi.fn();
    const onResetFontSize = vi.fn();
    render(
      <SettingsView
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
      <SettingsView
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
      <SettingsView
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
      <SettingsView language="ja" onSaveLanguage={() => {}} fontSize={13} />,
    );
    expect(
      screen.getByRole("group", { name: "ターミナルの文字サイズ" }),
    ).toBeTruthy();
  });

  it("hides the clipboard-edit toggle when onSetClipboardEditModal is omitted", () => {
    render(<SettingsView language="ja" onSaveLanguage={() => {}} />);
    expect(screen.queryByText("コピー時にクリップボード編集を表示")).toBeNull();
  });

  it("reflects and toggles the clipboard-edit setting", () => {
    const onSetClipboardEditModal = vi.fn();
    render(
      <SettingsView
        language="ja"
        onSaveLanguage={() => {}}
        clipboardEditModal={true}
        onSetClipboardEditModal={onSetClipboardEditModal}
      />,
    );
    const box = screen.getByRole("checkbox", {
      name: "コピー時にクリップボード編集を表示",
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onSetClipboardEditModal).toHaveBeenCalledWith(false);
  });

  it("hides the update-check entry when onCheckForUpdates is omitted", () => {
    render(<SettingsView language="ja" onSaveLanguage={() => {}} />);
    expect(
      screen.queryByRole("button", { name: "アップデートを確認" }),
    ).toBeNull();
  });

  it("runs the check and shows the newer version when one is available", async () => {
    const onCheckForUpdates = vi.fn().mockResolvedValue({
      t: "update.check.result",
      status: "available",
      version: "0.2.0",
    } satisfies UpdateCheckResultMessage);
    render(
      <SettingsView
        language="ja"
        onSaveLanguage={() => {}}
        onCheckForUpdates={onCheckForUpdates}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "アップデートを確認" }));
    expect(onCheckForUpdates).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("バージョン 0.2.0 が利用できます。"),
    ).toBeTruthy();
  });

  it("reports being up to date", async () => {
    render(
      <SettingsView
        language="ja"
        onSaveLanguage={() => {}}
        onCheckForUpdates={vi.fn().mockResolvedValue({
          t: "update.check.result",
          status: "upToDate",
          version: null,
        } satisfies UpdateCheckResultMessage)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "アップデートを確認" }));
    expect(await screen.findByText("最新バージョンです。")).toBeTruthy();
  });

  it("reports an error when the check rejects", async () => {
    render(
      <SettingsView
        language="ja"
        onSaveLanguage={() => {}}
        onCheckForUpdates={vi.fn().mockRejectedValue(new Error("offline"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "アップデートを確認" }));
    expect(
      await screen.findByText("アップデートを確認できませんでした。"),
    ).toBeTruthy();
  });
});
