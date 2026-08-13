import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { type Locale, SUPPORTED_LOCALES } from "../i18n/detect.js";
import { PanelHeader } from "./PanelHeader.js";
import { panelClass } from "./panels.js";

export interface SettingsPanelProps {
  /** Current display language (i18n.language). */
  language: string;
  /** Apply the language and persist it to config.json (Save). */
  onSaveLanguage(language: Locale): void;
  /**
   * Current terminal font size (px). When omitted, the font-size field is not shown
   * (keeps the panel usable without the terminal font-size wiring, e.g. in isolated tests).
   */
  fontSize?: number;
  /** Enlarge the terminal font by one step (A+). */
  onIncreaseFontSize?(): void;
  /** Shrink the terminal font by one step (A-). */
  onDecreaseFontSize?(): void;
  /** Reset the terminal font to the default size. */
  onResetFontSize?(): void;
  /** Whether A+ is still available (false at the maximum). */
  canIncreaseFontSize?: boolean;
  /** Whether A- is still available (false at the minimum). */
  canDecreaseFontSize?: boolean;
  /** Whether Reset is meaningful (false when already at the default size). */
  canResetFontSize?: boolean;
  /** Open the "add org" modal (shared with the SESSION LIST header). Omit to hide the entry. */
  onAddOrg?(): void;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
}

function toLocale(lang: string): Locale {
  return lang === "ja" ? "ja" : "en";
}

/**
 * Settings panel (the gear in NAVIGATION). Currently only a display-language dropdown.
 * Save applies the selection and persists it to config.json (while unsaved, the draft
 * is kept and Save stays enabled).
 */
export function SettingsPanel({
  language,
  onSaveLanguage,
  fontSize,
  onIncreaseFontSize,
  onDecreaseFontSize,
  onResetFontSize,
  canIncreaseFontSize = true,
  canDecreaseFontSize = true,
  canResetFontSize = true,
  onAddOrg,
  inactive,
}: SettingsPanelProps) {
  const { t } = useTranslation();
  const current = toLocale(language);
  const [draft, setDraft] = useState<Locale>(current);
  // Follow the draft when the language changes externally (config.sync).
  useEffect(() => setDraft(current), [current]);

  return (
    <section
      className={panelClass("settings-panel", inactive)}
      data-panel="settings"
    >
      <PanelHeader title="SETTINGS" />
      <div className="settings-body">
        <label className="settings-field">
          <span className="settings-label">{t("settings.language")}</span>
          <select
            className="settings-select"
            value={draft}
            onChange={(e) => setDraft(toLocale(e.target.value))}
          >
            {SUPPORTED_LOCALES.map((loc) => (
              <option key={loc} value={loc}>
                {t(`settings.languageOption.${loc}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="settings-save"
          disabled={draft === current}
          onClick={() => onSaveLanguage(draft)}
        >
          {t("settings.save")}
        </button>
        {fontSize !== undefined && (
          <fieldset className="settings-field font-size-field">
            <legend className="settings-label">{t("settings.fontSize")}</legend>
            <div className="font-size-controls">
              <button
                type="button"
                className="font-size-button"
                aria-label={t("settings.fontSizeDecrease")}
                title={t("settings.fontSizeDecrease")}
                disabled={!canDecreaseFontSize}
                onClick={onDecreaseFontSize}
              >
                A-
              </button>
              <span className="font-size-value" aria-live="polite">
                {fontSize}px
              </span>
              <button
                type="button"
                className="font-size-button"
                aria-label={t("settings.fontSizeIncrease")}
                title={t("settings.fontSizeIncrease")}
                disabled={!canIncreaseFontSize}
                onClick={onIncreaseFontSize}
              >
                A+
              </button>
              <button
                type="button"
                className="font-size-reset"
                disabled={!canResetFontSize}
                onClick={onResetFontSize}
              >
                {t("settings.fontSizeReset")}
              </button>
            </div>
          </fieldset>
        )}
        {onAddOrg !== undefined && (
          <div className="settings-field">
            <span className="settings-label">{t("settings.orgSection")}</span>
            <button type="button" className="settings-save" onClick={onAddOrg}>
              {t("settings.addOrg")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
