import type { FooterBand, FooterThresholds } from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type IndicatorKey = keyof FooterThresholds;
type BandKey = "warn" | "high" | "crit";

interface IndicatorMeta {
  key: IndicatorKey;
  bands: BandKey[];
  /** Stored value = displayed value × scale (elapsed is edited in hours, stored in ms). */
  scale: number;
  step: number;
  unit: "percent" | "tokens" | "hours";
}

const INDICATORS: IndicatorMeta[] = [
  {
    key: "usagePercent",
    bands: ["warn", "high", "crit"],
    scale: 1,
    step: 1,
    unit: "percent",
  },
  {
    key: "sessionTokens",
    bands: ["warn", "crit"],
    scale: 1,
    step: 100_000,
    unit: "tokens",
  },
  {
    key: "elapsedMs",
    bands: ["crit"],
    scale: 3_600_000,
    step: 1,
    unit: "hours",
  },
];

function bandOf(
  t: FooterThresholds,
  key: IndicatorKey,
  band: BandKey,
): FooterBand {
  return (t[key] as Record<BandKey, FooterBand>)[band];
}

function withBand(
  t: FooterThresholds,
  key: IndicatorKey,
  band: BandKey,
  patch: Partial<FooterBand>,
): FooterThresholds {
  const indicator = {
    ...t[key],
    [band]: { ...bandOf(t, key, band), ...patch },
  };
  return { ...t, [key]: indicator };
}

export interface FooterThresholdsFieldProps {
  value: FooterThresholds;
  onSave(thresholds: FooterThresholds): void;
}

/**
 * Editor for the status-footer severity thresholds: per indicator, per band a show/hide toggle and a
 * numeric boundary. Edits stay local until Save, which pushes the whole object to the server. Disabling
 * a band lets a reading fall through to the next lower enabled band.
 */
export function FooterThresholdsField({
  value,
  onSave,
}: FooterThresholdsFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<FooterThresholds>(value);
  // Follow the persisted value when it changes externally (config.sync from another client).
  const persisted = JSON.stringify(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the serialized persisted value, not the object identity
  useEffect(() => setDraft(value), [persisted]);

  const dirty = JSON.stringify(draft) !== persisted;

  return (
    <div className="settings-field settings-field-column footer-thresholds">
      <span className="settings-label">
        {t("settings.footerThresholds.section")}
      </span>
      <span className="settings-hint">
        {t("settings.footerThresholds.hint")}
      </span>
      {INDICATORS.map((ind) => (
        <fieldset key={ind.key} className="footer-thresholds-group">
          <legend>{t(`settings.footerThresholds.indicator.${ind.key}`)}</legend>
          {ind.bands.map((band) => {
            const b = bandOf(draft, ind.key, band);
            return (
              <div key={band} className="footer-thresholds-row">
                <label className="footer-thresholds-toggle">
                  <input
                    type="checkbox"
                    checked={b.enabled}
                    onChange={(e) =>
                      setDraft((d) =>
                        withBand(d, ind.key, band, {
                          enabled: e.target.checked,
                        }),
                      )
                    }
                  />
                  <span>{t(`settings.footerThresholds.band.${band}`)}</span>
                </label>
                <input
                  type="number"
                  className="footer-thresholds-value"
                  min={0}
                  step={ind.step}
                  value={b.value / ind.scale}
                  aria-label={t(
                    `settings.footerThresholds.indicator.${ind.key}`,
                  )}
                  onChange={(e) => {
                    const shown = Number.parseFloat(e.target.value);
                    if (!Number.isFinite(shown) || shown < 0) return;
                    setDraft((d) =>
                      withBand(d, ind.key, band, {
                        value: Math.round(shown * ind.scale),
                      }),
                    );
                  }}
                />
                <span className="footer-thresholds-unit">
                  {t(`settings.footerThresholds.unit.${ind.unit}`)}
                </span>
              </div>
            );
          })}
        </fieldset>
      ))}
      <button
        type="button"
        className="settings-save"
        disabled={!dirty}
        onClick={() => onSave(draft)}
      >
        {t("settings.save")}
      </button>
    </div>
  );
}
