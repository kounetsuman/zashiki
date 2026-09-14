import {
  DASHBOARD_FREQUENCIES,
  DASHBOARD_SHOW_ON,
  type DashboardFrequency,
  type DashboardSettings,
  type DashboardShowOn,
} from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useUnsavedField } from "./unsaved-changes.js";

export interface DashboardSettingsFieldProps {
  value: DashboardSettings;
  onSave(dashboard: DashboardSettings): void;
}

/**
 * Editor for the page shown in front of the cockpit at launch / on wake from sleep. Edits stay local
 * until Save, which pushes the whole object to the server. A blank address turns the feature off.
 */
export function DashboardSettingsField({
  value,
  onSave,
}: DashboardSettingsFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DashboardSettings>(value);
  // Follow the persisted value when it changes externally (config.sync from another client).
  const persisted = JSON.stringify(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the serialized persisted value, not the object identity
  useEffect(() => setDraft(value), [persisted]);

  // The server stores the address trimmed, so compare and send it trimmed too; otherwise saving a
  // stray space comes back unchanged and the field can never leave the unsaved state.
  const trimmed = { ...draft, url: draft.url.trim() };
  const dirty = JSON.stringify(trimmed) !== persisted;
  useUnsavedField("dashboard", dirty, {
    save: () => onSave(trimmed),
    discard: () => setDraft(value),
  });

  return (
    <div className="settings-field settings-field-column">
      <span className="settings-label">{t("settings.dashboard.section")}</span>
      <span className="settings-hint">{t("settings.dashboard.hint")}</span>
      <input
        type="text"
        className="settings-input"
        value={draft.url}
        placeholder="https://example.com/board"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={t("settings.dashboard.url")}
        onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
      />
      <div className="dashboard-settings-row">
        <label className="dashboard-settings-choice">
          <span>{t("settings.dashboard.showOn")}</span>
          <select
            className="settings-select"
            value={draft.showOn}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                showOn: e.target.value as DashboardShowOn,
              }))
            }
          >
            {DASHBOARD_SHOW_ON.map((moment) => (
              <option key={moment} value={moment}>
                {t(`settings.dashboard.showOnOption.${moment}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="dashboard-settings-choice">
          <span>{t("settings.dashboard.frequency")}</span>
          <select
            className="settings-select"
            value={draft.frequency}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                frequency: e.target.value as DashboardFrequency,
              }))
            }
          >
            {DASHBOARD_FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>
                {t(`settings.dashboard.frequencyOption.${frequency}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        className="settings-save"
        disabled={!dirty}
        onClick={() => onSave(trimmed)}
      >
        {t("settings.save")}
      </button>
    </div>
  );
}
