import type { LaunchLimitOverride, StallRules } from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  MAX_STALL_MINUTES,
  MAX_STALL_REPEAT,
  sanitizeStallRules,
} from "../lib/stall-rules.js";
import { useUnsavedField } from "./unsaved-changes.js";

type NumberKey = "launchLimitMin" | "quietLimitMin" | "repeatLimit";

const NUMBER_FIELDS: {
  key: NumberKey;
  unit: "minutes" | "times";
  max: number;
}[] = [
  { key: "launchLimitMin", unit: "minutes", max: MAX_STALL_MINUTES },
  { key: "quietLimitMin", unit: "minutes", max: MAX_STALL_MINUTES },
  { key: "repeatLimit", unit: "times", max: MAX_STALL_REPEAT },
];

const parseWhole = (text: string, max: number): number | null => {
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : null;
};

export interface StallRulesFieldProps {
  value: StallRules;
  onSave(rules: StallRules): void;
}

/**
 * Editor for when a background task counts as stalled: the three limits, plus per-command launch
 * limits matched by "the command contains this text". Edits stay local until Save.
 */
export function StallRulesField({ value, onSave }: StallRulesFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<StallRules>(value);
  const persisted = JSON.stringify(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the serialized persisted value, not the object identity
  useEffect(() => setDraft(value), [persisted]);

  const dirty = JSON.stringify(draft) !== persisted;
  const save = () => {
    onSave(draft);
    setDraft(sanitizeStallRules(draft));
  };
  useUnsavedField("stall-rules", dirty, {
    save,
    discard: () => setDraft(value),
  });

  const setOverride = (index: number, patch: Partial<LaunchLimitOverride>) =>
    setDraft((d) => ({
      ...d,
      overrides: d.overrides.map((o, i) =>
        i === index ? { ...o, ...patch } : o,
      ),
    }));

  return (
    <div className="settings-field settings-field-column stall-rules">
      <span className="settings-label">{t("settings.stallRules.section")}</span>
      <span className="settings-hint">{t("settings.stallRules.hint")}</span>
      {NUMBER_FIELDS.map(({ key, unit, max }) => (
        <label key={key} className="stall-rules-row">
          <span className="stall-rules-name">
            {t(`settings.stallRules.${key}`)}
          </span>
          <input
            type="number"
            className="stall-rules-input"
            min={1}
            max={max}
            step={1}
            value={draft[key]}
            onChange={(e) => {
              const n = parseWhole(e.target.value, max);
              if (n !== null) setDraft((d) => ({ ...d, [key]: n }));
            }}
          />
          <span className="stall-rules-unit">
            {t(`settings.stallRules.unit.${unit}`)}
          </span>
        </label>
      ))}
      <fieldset className="stall-rules-overrides">
        <legend>{t("settings.stallRules.overrides")}</legend>
        {draft.overrides.map((o, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position while being edited
          <div key={i} className="stall-rules-row">
            <input
              type="text"
              className="stall-rules-input stall-rules-match"
              aria-label={t("settings.stallRules.match")}
              placeholder="make ci"
              value={o.match}
              onChange={(e) => setOverride(i, { match: e.target.value })}
            />
            <input
              type="number"
              className="stall-rules-input"
              aria-label={t("settings.stallRules.launchLimitMin")}
              min={1}
              max={MAX_STALL_MINUTES}
              step={1}
              value={o.launchLimitMin}
              onChange={(e) => {
                const n = parseWhole(e.target.value, MAX_STALL_MINUTES);
                if (n !== null) setOverride(i, { launchLimitMin: n });
              }}
            />
            <span className="stall-rules-unit">
              {t("settings.stallRules.unit.minutes")}
            </span>
            <button
              type="button"
              className="stall-rules-remove"
              aria-label={t("settings.stallRules.remove")}
              title={t("settings.stallRules.remove")}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  overrides: d.overrides.filter((_, j) => j !== i),
                }))
              }
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        ))}
        <button
          type="button"
          className="stall-rules-add"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              overrides: [
                ...d.overrides,
                { match: "", launchLimitMin: d.launchLimitMin },
              ],
            }))
          }
        >
          {t("settings.stallRules.add")}
        </button>
      </fieldset>
      <button
        type="button"
        className="settings-save"
        disabled={!dirty}
        onClick={save}
      >
        {t("settings.save")}
      </button>
    </div>
  );
}
