import {
  NOTIFY_CATEGORIES,
  type NotificationSettings,
  type NotifyCategory,
  type NotifyCategoryPref,
  SOUND_PRESETS,
  type SoundPreset,
} from "@zashiki/shared";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import { playNotifySound } from "../lib/notify-sound.js";

export interface NotificationSettingsFieldProps {
  value: NotificationSettings;
  /** Persist the whole settings object (the server re-broadcasts it via config.sync). */
  onChange(value: NotificationSettings): void;
  /** Audition a preset. Defaults to the Web Audio synth; injected in tests. */
  previewSound?(preset: SoundPreset): void;
}

/**
 * The notifications section of SETTINGS: a master switch; per category an independent "show" toggle,
 * "sound" toggle, and sound-preset picker; and a preview strip to audition every preset. Category
 * rows are inert while the master is off. Each change persists the whole settings object immediately
 * (no Save button), matching the other live toggles. Preview plays regardless of the switches.
 */
export function NotificationSettingsField({
  value,
  onChange,
  previewSound = playNotifySound,
}: NotificationSettingsFieldProps) {
  const { t } = useTranslation();

  const setCategory = (
    category: NotifyCategory,
    patch: Partial<NotifyCategoryPref>,
  ): void => {
    onChange({
      ...value,
      categories: {
        ...value.categories,
        [category]: { ...value.categories[category], ...patch },
      },
    });
  };

  return (
    <fieldset className="settings-field settings-field-column notifications-field">
      <legend className="settings-label">{t("settings.notifications")}</legend>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <span className="settings-label">
          {t("settings.notificationsMaster")}
        </span>
      </label>
      <div className="notifications-grid">
        <span />
        <span className="notifications-col">
          {t("settings.notificationsShow")}
        </span>
        <span className="notifications-col">
          {t("settings.notificationsSound")}
        </span>
        <span className="notifications-col">
          {t("settings.notificationsSoundType")}
        </span>
        {NOTIFY_CATEGORIES.map((category) => {
          const label = t(`settings.notifyCategory.${category}`);
          return (
            <Fragment key={category}>
              <span className="settings-label">{label}</span>
              <input
                type="checkbox"
                aria-label={`${label} — ${t("settings.notificationsShow")}`}
                checked={value.categories[category].notify}
                disabled={!value.enabled}
                onChange={(e) =>
                  setCategory(category, { notify: e.target.checked })
                }
              />
              <input
                type="checkbox"
                aria-label={`${label} — ${t("settings.notificationsSound")}`}
                checked={value.categories[category].sound}
                disabled={!value.enabled}
                onChange={(e) =>
                  setCategory(category, { sound: e.target.checked })
                }
              />
              <select
                className="settings-select notifications-sound-select"
                aria-label={`${label} — ${t("settings.notificationsSoundType")}`}
                value={value.categories[category].soundType}
                disabled={!value.enabled || !value.categories[category].sound}
                onChange={(e) =>
                  setCategory(category, {
                    soundType: e.target.value as SoundPreset,
                  })
                }
              >
                {SOUND_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {t(`settings.soundPreset.${preset}`)}
                  </option>
                ))}
              </select>
            </Fragment>
          );
        })}
      </div>
      <div className="notifications-preview">
        <span className="notifications-preview-label">
          {t("settings.notificationsPreview")}
        </span>
        {SOUND_PRESETS.map((preset) => {
          const name = t(`settings.soundPreset.${preset}`);
          return (
            <button
              key={preset}
              type="button"
              className="notifications-preview-button"
              aria-label={t("settings.notificationsPreviewPlay", { name })}
              onClick={() => previewSound(preset)}
            >
              {name}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
