import { useTranslation } from "react-i18next";

import { PANEL_DEFS, type PanelDef, type PanelId } from "./panels.js";

export interface FooterPanelTabsProps {
  /** The currently shown panel (only this icon is colored). null means closed, with all icons inactive. */
  selected: PanelId | null;
  onSelect(id: PanelId): void;
  /** Display order (defaults to PANEL_DEFS). Future panels are just added here. */
  defs?: readonly PanelDef[];
  /** Panel id -> badge number (0/unspecified is hidden). Used for things like unread notification counts. */
  badges?: Partial<Record<PanelId, number>>;
}

/**
 * The panel-switch icons at the footer's right edge. Switches between explorer,
 * search, git, and help as a single selection. tab/tabpanel is meant to be 1:1,
 * but here there is a single selection region and SESSION LIST also lives
 * alongside, so those semantics do not fit. Since this is exactly a mutually
 * exclusive single selection, we use `role="radiogroup"` plus `role="radio"
 * aria-checked` on each icon (aria-pressed toggle buttons mean independent
 * on/off each and do not fit this use). The selected one is colored via
 * is-active. Keyboard use is handled alongside the App-side global
 * Ctrl+Alt+<key> (this is the click UI).
 */
export function FooterPanelTabs({
  selected,
  onSelect,
  defs = PANEL_DEFS,
  badges = {},
}: FooterPanelTabsProps) {
  const { t } = useTranslation();
  return (
    <div
      className="footer-panel-tabs"
      role="radiogroup"
      aria-label={t("footer.panelSwitch")}
    >
      {defs.map((d) => {
        const active = selected === d.id;
        const badge = badges[d.id] ?? 0;
        const baseLabel = t(d.labelKey);
        const label =
          badge > 0
            ? t("footer.unreadBadge", { label: baseLabel, count: badge })
            : baseLabel;
        return (
          // biome-ignore lint/a11y/useSemanticElements: input[type=radio] cannot hold icon children and is hard to style. Use a button with the radio role to ensure reliable keyboard operation
          <button
            key={d.id}
            type="button"
            role="radio"
            className={`footer-panel-tab${active ? " is-active" : ""}`}
            aria-checked={active}
            aria-label={label}
            title={t("footer.shortcutTitle", {
              label,
              key: d.shortcutKey.toUpperCase(),
            })}
            onClick={() => onSelect(d.id)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {d.icon}
            </span>
            {badge > 0 && (
              <span className="footer-panel-badge" aria-hidden="true">
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
