import { useTranslation } from "react-i18next";

export interface FooterSettingsButtonProps {
  onOpen(): void;
}

/** Footer gear that opens the settings modal (a plain button, not a view-switch radio). */
export function FooterSettingsButton({ onOpen }: FooterSettingsButtonProps) {
  const { t } = useTranslation();
  const label = t("view.settings");
  return (
    <button
      type="button"
      className="footer-view-tab"
      aria-label={label}
      title={t("footer.shortcutTitle", { label, key: "S" })}
      onClick={onOpen}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        settings
      </span>
    </button>
  );
}
