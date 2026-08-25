import { useTranslation } from "react-i18next";

import { VIEW_DEFS, type ViewDef, type ViewId } from "./views.js";

export interface NavigationBarProps {
  /** The view shown in the LEFT area (only this icon is colored). null means the LEFT area is closed. */
  selected: ViewId | null;
  onSelect(id: ViewId): void;
  onOpenHelp(): void;
  onOpenSettings(): void;
  /** Display order (defaults to VIEW_DEFS). Future views are just added here. */
  defs?: readonly ViewDef[];
  /** View id -> badge number (0/unspecified is hidden). Used for things like unread notification counts. */
  badges?: Partial<Record<ViewId, number>>;
}

/**
 * The vertical navigation activity bar on the far left (VS Code style). The view-switch icons pick
 * which view fills the LEFT area as a single selection; the help and settings buttons are pinned at
 * the bottom (each opens its own modal, so they are plain buttons, not part of the radiogroup).
 * The icons use the same mutually-exclusive single-selection semantics as before, so they are a
 * `role="radiogroup"` of `role="radio"` buttons (aria-pressed toggles would imply independent
 * on/off each and do not fit). The selected one is colored via is-active. Keyboard switching is
 * handled globally (Ctrl+Alt+<key>); this is the click UI.
 */
export function NavigationBar({
  selected,
  onSelect,
  onOpenHelp,
  onOpenSettings,
  defs = VIEW_DEFS,
  badges = {},
}: NavigationBarProps) {
  const { t } = useTranslation();
  return (
    <nav className="nav-bar" aria-label={t("nav.ariaLabel")}>
      <div
        className="nav-items"
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
              className={`nav-item${active ? " is-active" : ""}`}
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
                <span className="nav-badge" aria-hidden="true">
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="nav-item nav-item-help"
        aria-label={t("view.help")}
        title={t("footer.shortcutTitle", {
          label: t("view.help"),
          key: "H",
        })}
        onClick={onOpenHelp}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          help
        </span>
      </button>
      <button
        type="button"
        className="nav-item nav-item-settings"
        aria-label={t("view.settings")}
        title={t("footer.shortcutTitle", {
          label: t("view.settings"),
          key: "S",
        })}
        onClick={onOpenSettings}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          settings
        </span>
      </button>
    </nav>
  );
}
