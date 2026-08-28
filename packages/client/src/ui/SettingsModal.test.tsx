// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  DEFAULT_FOOTER_THRESHOLDS,
  DEFAULT_NOTIFICATION_SETTINGS,
  type UpdateCheckResultMessage,
} from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "./SettingsModal.js";

afterEach(cleanup);

const noop = () => {};

describe("SettingsModal shell", () => {
  it("renders a dialog with General and Development tabs, General active by default", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(screen.getByRole("dialog", { name: "設定" })).toBeTruthy();
    const general = screen.getByRole("tab", { name: "一般" });
    const developer = screen.getByRole("tab", { name: "開発モード" });
    expect(general.getAttribute("aria-selected")).toBe("true");
    expect(developer.getAttribute("aria-selected")).toBe("false");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape pressed from a control inside the dialog", () => {
    const onClose = vi.fn();
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={onClose} />,
    );
    fireEvent.keyDown(screen.getByLabelText("表示言語"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a backdrop click but not on a click inside the dialog", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("dialog", { name: "設定" }));
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps an unsaved language draft when switching to Development and back", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    fireEvent.change(screen.getByLabelText("表示言語"), {
      target: { value: "en" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "開発モード" }));
    fireEvent.click(screen.getByRole("tab", { name: "一般" }));
    const select = screen.getByLabelText("表示言語") as HTMLSelectElement;
    expect(select.value).toBe("en");
    expect(
      (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("SettingsModal General tab", () => {
  it("reflects the current language in the dropdown and disables Save when unchanged", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    const select = screen.getByLabelText("表示言語") as HTMLSelectElement;
    expect(select.value).toBe("ja");
    const save = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("renders the ja / en options", () => {
    render(
      <SettingsModal language="en" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(screen.getByRole("option", { name: "日本語" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
  });

  it("shows the add-org entry only when onAddOrg is provided and calls it on click", () => {
    const onAddOrg = vi.fn();
    const { rerender } = render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(screen.queryByRole("button", { name: "組織を追加" })).toBeNull();
    rerender(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        onAddOrg={onAddOrg}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "組織を追加" }));
    expect(onAddOrg).toHaveBeenCalled();
  });

  it("calls onSaveLanguage with the selected language after changing it and saving", () => {
    const onSaveLanguage = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={onSaveLanguage}
        onClose={noop}
      />,
    );
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

  it("surfaces the unsaved-changes bar on a draft edit and saves it via Save all", () => {
    const onSaveLanguage = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={onSaveLanguage}
        onClose={noop}
      />,
    );
    expect(screen.queryByText("編集が保存されていません")).toBeNull();

    fireEvent.change(screen.getByLabelText("表示言語"), {
      target: { value: "en" },
    });
    expect(screen.getByText("編集が保存されていません")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "すべて保存" }));
    expect(onSaveLanguage).toHaveBeenCalledWith("en");
  });

  it("reverts a draft edit and hides the bar via Discard", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    const select = screen.getByLabelText("表示言語") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "en" } });
    expect(screen.getByText("編集が保存されていません")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "破棄" }));
    expect(select.value).toBe("ja");
    expect(screen.queryByText("編集が保存されていません")).toBeNull();
  });

  it("does not render the font-size controls when fontSize is omitted", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(screen.queryByText("ターミナルの文字サイズ")).toBeNull();
  });

  it("shows the current font size and wires A- / A+ / reset", () => {
    const onIncreaseFontSize = vi.fn();
    const onDecreaseFontSize = vi.fn();
    const onResetFontSize = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
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
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
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
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
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
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        fontSize={13}
      />,
    );
    expect(
      screen.getByRole("group", { name: "ターミナルの文字サイズ" }),
    ).toBeTruthy();
  });

  it("hides the clipboard-edit toggle when onSetClipboardEditModal is omitted", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(screen.queryByText("コピー時にクリップボード編集を表示")).toBeNull();
  });

  it("reflects and toggles the clipboard-edit setting", () => {
    const onSetClipboardEditModal = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
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

  it("hides the editor field when onSaveEditor is omitted", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(screen.queryByText("外部エディタコマンド")).toBeNull();
  });

  it("reflects the current editor command and disables Save until it changes", () => {
    const onSaveEditor = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        editor="cursor -g"
        onSaveEditor={onSaveEditor}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "外部エディタコマンド",
    }) as HTMLInputElement;
    expect(input.value).toBe("cursor -g");
    const field = input.closest("div.settings-field") as HTMLElement;
    const save = within(field).getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "code -w" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSaveEditor).toHaveBeenCalledWith("code -w");
  });

  it("shows the welcome-guide entry only when onShowOnboarding is provided and calls it on click", () => {
    const onShowOnboarding = vi.fn();
    const { rerender } = render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(
      screen.queryByRole("button", { name: "案内をもう一度見る" }),
    ).toBeNull();
    rerender(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        onShowOnboarding={onShowOnboarding}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "案内をもう一度見る" }));
    expect(onShowOnboarding).toHaveBeenCalledOnce();
  });

  it("hides the update-check entry when onCheckForUpdates is omitted", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
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
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
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
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
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
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        onCheckForUpdates={vi.fn().mockRejectedValue(new Error("offline"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "アップデートを確認" }));
    expect(
      await screen.findByText("アップデートを確認できませんでした。"),
    ).toBeTruthy();
  });
});

describe("SettingsModal Development tab", () => {
  const openDeveloper = () =>
    fireEvent.click(screen.getByRole("tab", { name: "開発モード" }));

  it("keeps the Development tab available even without renderer wiring", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    openDeveloper();
    expect(screen.getByRole("tab", { name: "開発モード" })).toBeTruthy();
    expect(screen.queryByLabelText("ターミナルレンダラ")).toBeNull();
  });

  it("switches the renderer via the Development tab dropdown", () => {
    const onSetRenderer = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        renderer="webgl"
        onSetRenderer={onSetRenderer}
      />,
    );
    openDeveloper();
    const select = screen.getByLabelText(
      "ターミナルレンダラ",
    ) as HTMLSelectElement;
    expect(select.value).toBe("webgl");
    fireEvent.change(select, { target: { value: "dom" } });
    expect(onSetRenderer).toHaveBeenCalledWith("dom");
  });

  it("shows the DevTools button only when onOpenDevtools is provided", () => {
    const onOpenDevtools = vi.fn();
    const { rerender } = render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        renderer="webgl"
        onSetRenderer={noop}
      />,
    );
    openDeveloper();
    expect(
      screen.queryByRole("button", { name: "DevTools を開く" }),
    ).toBeNull();
    rerender(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        renderer="webgl"
        onSetRenderer={noop}
        onOpenDevtools={onOpenDevtools}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "DevTools を開く" }));
    expect(onOpenDevtools).toHaveBeenCalledOnce();
  });

  it("calls onOpenDebugPanel when the debug-panel button is clicked", () => {
    const onOpenDebugPanel = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        renderer="webgl"
        onSetRenderer={noop}
        onOpenDebugPanel={onOpenDebugPanel}
      />,
    );
    openDeveloper();
    fireEvent.click(
      screen.getByRole("button", { name: "デバッグパネルを開く" }),
    );
    expect(onOpenDebugPanel).toHaveBeenCalledOnce();
  });
});

describe("SettingsModal Claude Code integration", () => {
  const status = {
    hooksRegistered: false,
    statusLineRegistered: false,
    statusLineConflict: false,
  };

  it("hides the integration toggle when status or handler is absent", () => {
    render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(
      screen.queryByText("Claude Code 連携（通知・使用率フッタ）"),
    ).toBeNull();
  });

  it("reflects fully-registered as checked and toggles register on/off", () => {
    const onSet = vi.fn();
    const { rerender } = render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        hooksStatus={status}
        onSetHooksRegistered={onSet}
      />,
    );
    const toggle = screen.getByRole("checkbox", {
      name: "Claude Code 連携（通知・使用率フッタ）",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onSet).toHaveBeenCalledWith(true);

    rerender(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        hooksStatus={{
          hooksRegistered: true,
          statusLineRegistered: true,
          statusLineConflict: false,
        }}
        onSetHooksRegistered={onSet}
      />,
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Claude Code 連携（通知・使用率フッタ）",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("surfaces the wrap notice when a foreign statusLine conflicts", () => {
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        hooksStatus={{ ...status, statusLineConflict: true }}
        onSetHooksRegistered={noop}
      />,
    );
    expect(
      screen.getByText(
        "既存の statusLine があります。有効化すると、それをラップして zashiki と併存させます。",
      ),
    ).toBeTruthy();
  });

  it("shows the footer-threshold editor only when its handler is wired", () => {
    const { rerender } = render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(screen.queryByText("フッタの色分け閾値")).toBeNull();

    rerender(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        footerThresholds={DEFAULT_FOOTER_THRESHOLDS}
        onSaveFooterThresholds={noop}
      />,
    );
    expect(screen.getByText("フッタの色分け閾値")).toBeTruthy();
  });

  it("shows the notifications section only when its handler is wired", () => {
    const { rerender } = render(
      <SettingsModal language="ja" onSaveLanguage={noop} onClose={noop} />,
    );
    expect(screen.queryByLabelText("通知を有効にする")).toBeNull();

    rerender(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        notificationSettings={DEFAULT_NOTIFICATION_SETTINGS}
        onSetNotifications={noop}
      />,
    );
    expect(screen.getByLabelText("通知を有効にする")).toBeTruthy();
    expect(screen.getByLabelText("サブエージェント開始 — 通知")).toBeTruthy();
    expect(screen.getByLabelText("サブエージェント開始 — 音")).toBeTruthy();
  });

  it("toggling a category's show/sound persists the whole settings object", () => {
    const onSetNotifications = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        notificationSettings={DEFAULT_NOTIFICATION_SETTINGS}
        onSetNotifications={onSetNotifications}
      />,
    );
    fireEvent.click(screen.getByLabelText("サブエージェント開始 — 音"));
    expect(onSetNotifications).toHaveBeenCalledWith({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      categories: {
        ...DEFAULT_NOTIFICATION_SETTINGS.categories,
        subagentStart: { notify: false, sound: true },
      },
    });
  });

  it("turning the master off persists enabled:false", () => {
    const onSetNotifications = vi.fn();
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        notificationSettings={DEFAULT_NOTIFICATION_SETTINGS}
        onSetNotifications={onSetNotifications}
      />,
    );
    fireEvent.click(screen.getByLabelText("通知を有効にする"));
    expect(onSetNotifications).toHaveBeenCalledWith({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      enabled: false,
    });
  });

  it("category toggles are disabled while the master is off", () => {
    render(
      <SettingsModal
        language="ja"
        onSaveLanguage={noop}
        onClose={noop}
        notificationSettings={{
          ...DEFAULT_NOTIFICATION_SETTINGS,
          enabled: false,
        }}
        onSetNotifications={noop}
      />,
    );
    expect(
      (screen.getByLabelText("完了 — 通知") as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
