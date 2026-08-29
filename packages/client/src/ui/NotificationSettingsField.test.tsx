// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_NOTIFICATION_SETTINGS, SOUND_PRESETS } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationSettingsField } from "./NotificationSettingsField.js";

afterEach(cleanup);

const noop = () => {};

describe("NotificationSettingsField sound presets", () => {
  it("renders one preview button per preset and auditions on click", () => {
    const previewSound = vi.fn();
    render(
      <NotificationSettingsField
        value={DEFAULT_NOTIFICATION_SETTINGS}
        onChange={noop}
        previewSound={previewSound}
      />,
    );
    fireEvent.click(screen.getByLabelText("ベル を再生"));
    expect(previewSound).toHaveBeenCalledWith("bell");
  });

  it("preview auditions regardless of the master switch", () => {
    const previewSound = vi.fn();
    render(
      <NotificationSettingsField
        value={{ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false }}
        onChange={noop}
        previewSound={previewSound}
      />,
    );
    fireEvent.click(screen.getByLabelText("チャイム を再生"));
    expect(previewSound).toHaveBeenCalledWith("chime");
  });

  it("disables the per-category sound-preset select while the master is off", () => {
    render(
      <NotificationSettingsField
        value={{ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false }}
        onChange={noop}
        previewSound={noop}
      />,
    );
    expect(
      (screen.getByLabelText("完了 — 音の種類") as HTMLSelectElement).disabled,
    ).toBe(true);
  });

  it("disables a category's sound-preset select when that category's sound is off", () => {
    const value = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      categories: {
        ...DEFAULT_NOTIFICATION_SETTINGS.categories,
        done: {
          ...DEFAULT_NOTIFICATION_SETTINGS.categories.done,
          sound: false,
        },
      },
    };
    render(
      <NotificationSettingsField
        value={value}
        onChange={noop}
        previewSound={noop}
      />,
    );
    expect(
      (screen.getByLabelText("完了 — 音の種類") as HTMLSelectElement).disabled,
    ).toBe(true);
  });

  it("offers every preset as an option for a category", () => {
    render(
      <NotificationSettingsField
        value={DEFAULT_NOTIFICATION_SETTINGS}
        onChange={noop}
        previewSound={noop}
      />,
    );
    const select = screen.getByLabelText(
      "完了 — 音の種類",
    ) as HTMLSelectElement;
    expect(select.querySelectorAll("option")).toHaveLength(
      SOUND_PRESETS.length,
    );
  });
});
