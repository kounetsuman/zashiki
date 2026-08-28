import {
  NOTIFY_CATEGORIES,
  type NotificationSettings,
  type NotifyCategory,
  type NotifyCategoryPref,
} from "@zashiki/shared";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

export interface NotificationSettingsFieldProps {
  value: NotificationSettings;
  /** Persist the whole settings object (the server re-broadcasts it via config.sync). */
  onChange(value: NotificationSettings): void;
}

/**
 * The notifications section of SETTINGS: a master switch plus, per category, an independent "show"
 * and "sound" toggle. Category rows are inert while the master is off. Each change persists the whole
 * settings object immediately (no Save button), matching the other live toggles.
 */
export function NotificationSettingsField({
  value,
  onChange,
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
            </Fragment>
          );
        })}
      </div>
    </fieldset>
  );
}
