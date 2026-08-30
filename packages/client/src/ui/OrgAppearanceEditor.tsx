import {
  ORG_ALIAS_MAX_CHARS,
  resolveOrgColor,
  resolveOrgName,
} from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface OrgAppearanceEditorProps {
  /** Orgs to list (display order from state.sync). */
  orgs: string[];
  /** org → explicit color from repos.conf (absent falls back to the automatic hash color). */
  colors: Record<string, string>;
  /** org → explicit alias from repos.conf (absent falls back to the org identity). */
  aliases: Record<string, string>;
  /** Set an org's color (a blank value resets to the automatic color). */
  onSaveColor(org: string, color: string): void;
  /** Set an org's alias (a blank value resets to the org identity). */
  onSaveAlias(org: string, alias: string): void;
}

/** `<input type="color">` accepts only `#rrggbb`; expand a `#rgb` shorthand and reject anything else. */
function toHexInputValue(color: string): string {
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(color);
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#000000";
}

/**
 * A per-org appearance editor for the SETTINGS → Organizations tab: one row per org with a native color
 * picker (and a reset-to-automatic button) plus an alias field. Both persist on commit — the color on
 * blur (so dragging across the picker does not fire a write per intermediate value), the alias on its
 * Save button — and reset when their field is cleared. The rendered name and swatch follow the stored
 * values, which update via state.sync.
 */
export function OrgAppearanceEditor({
  orgs,
  colors,
  aliases,
  onSaveColor,
  onSaveAlias,
}: OrgAppearanceEditorProps) {
  const { t } = useTranslation();
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [colorDrafts, setColorDrafts] = useState<Record<string, string>>({});

  if (orgs.length === 0) {
    return (
      <span className="settings-hint">{t("settings.orgAppearanceEmpty")}</span>
    );
  }
  return (
    <ul className="settings-org-appearance">
      {orgs.map((org) => {
        const name = resolveOrgName(org, aliases);
        const storedAlias = aliases[org] ?? "";
        const aliasDraft = aliasDrafts[org] ?? storedAlias;
        const aliasDirty = aliasDraft.trim() !== storedAlias;
        const storedColor = toHexInputValue(resolveOrgColor(org, colors));
        const colorValue = colorDrafts[org] ?? storedColor;
        return (
          <li key={org} className="settings-org-appearance-row">
            <span
              className="settings-org-appearance-name"
              style={{ color: resolveOrgColor(org, colors) }}
            >
              {name}
            </span>
            <input
              type="color"
              className="settings-org-color"
              aria-label={t("settings.orgColorLabel", { org: name })}
              value={colorValue}
              onChange={(e) =>
                setColorDrafts((d) => ({ ...d, [org]: e.target.value }))
              }
              onBlur={() => {
                if (colorValue !== storedColor) onSaveColor(org, colorValue);
              }}
            />
            <button
              type="button"
              className="settings-org-color-reset"
              onClick={() => {
                setColorDrafts(({ [org]: _drop, ...rest }) => rest);
                onSaveColor(org, "");
              }}
            >
              {t("settings.orgColorReset")}
            </button>
            <input
              type="text"
              className="settings-input settings-org-alias"
              aria-label={t("settings.orgAliasLabel", { org })}
              value={aliasDraft}
              placeholder={t("settings.orgAliasPlaceholder")}
              maxLength={ORG_ALIAS_MAX_CHARS}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) =>
                setAliasDrafts((d) => ({ ...d, [org]: e.target.value }))
              }
            />
            <button
              type="button"
              className="settings-save"
              disabled={!aliasDirty}
              onClick={() => onSaveAlias(org, aliasDraft.trim())}
            >
              {t("settings.orgAliasSave")}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
