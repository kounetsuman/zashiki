import { ZASHIKI_RELEASES_URL } from "@zashiki/shared";
import { useTranslation } from "react-i18next";

/**
 * Header banner offering to update when the server's update checker has
 * announced a newer release (shown only then). The link opens the GitHub
 * releases page; the packaged Tauri shell opens target=_blank in the browser.
 */
export function UpdateBanner({ version }: { version: string | null }) {
  const { t } = useTranslation();
  if (version === null) return null;
  return (
    <div className="update-banner">
      <a
        className="update-banner-button"
        href={ZASHIKI_RELEASES_URL}
        target="_blank"
        rel="noreferrer"
        title={t("update.tooltip", { version })}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          upgrade
        </span>
        <span>{t("update.button")}</span>
      </a>
    </div>
  );
}
