import { useTranslation } from "react-i18next";

import { VIEW_DEFS, type ViewDef, type ViewId } from "./views.js";

export interface FooterViewTabsProps {
  /** The currently shown view (only this icon is colored). null means closed, with all icons inactive. */
  selected: ViewId | null;
  onSelect(id: ViewId): void;
  /** Display order (defaults to VIEW_DEFS). Future views are just added here. */
  defs?: readonly ViewDef[];
  /** View id -> badge number (0/unspecified is hidden). Used for things like unread notification counts. */
  badges?: Partial<Record<ViewId, number>>;
}

/**
 * The view-switch icons at the footer's right edge. Switches between explorer,
 * search, git, and help as a single selection. tab/tabpanel is meant to be 1:1,
 * but here there is a single selection region and SESSION LIST also lives
 * alongside, so those semantics do not fit. Since this is exactly a mutually
 * exclusive single selection, we use `role="radiogroup"` plus `role="radio"
 * aria-checked` on each icon (aria-pressed toggle buttons mean independent
 * on/off each and do not fit this use). The selected one is colored via
 * is-active. Keyboard use is handled alongside the App-side global
 * Ctrl+Alt+<key> (this is the click UI).
 */
export function FooterViewTabs({
  selected,
  onSelect,
  defs = VIEW_DEFS,
  badges = {},
}: FooterViewTabsProps) {
  const { t } = useTranslation();
  return (
    <div
      className="footer-view-tabs"
      role="radiogroup"
      aria-label={t("footer.viewSwitch")}
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
            className={`footer-view-tab${active ? " is-active" : ""}`}
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
              <span className="footer-view-badge" aria-hidden="true">
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
