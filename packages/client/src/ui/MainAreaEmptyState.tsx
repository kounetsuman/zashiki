import { Trans, useTranslation } from "react-i18next";
import logoUrl from "../assets/logo.png";

/** Empty state shown in the main area when there are no cockpit terminals. */
export function EmptyMainArea() {
  const { t } = useTranslation();
  return (
    <div className="empty-main-area">
      <div className="empty-main-area-inner">
        <img
          className="empty-main-area-mark"
          src={logoUrl}
          alt=""
          aria-hidden="true"
        />
        <p className="empty-main-area-title">{t("emptyMainArea.title")}</p>
        <p className="empty-main-area-hint">
          <Trans
            i18nKey="emptyMainArea.hint"
            components={{
              plus: <span className="empty-key" />,
              br: <br />,
            }}
          />
        </p>
      </div>
    </div>
  );
}

/** Empty state shown when there are cockpit terminals but no tab is open. */
export function NoTabOpen() {
  const { t } = useTranslation();
  return (
    <div className="empty-main-area">
      <div className="empty-main-area-inner">
        <img
          className="empty-main-area-mark"
          src={logoUrl}
          alt=""
          aria-hidden="true"
        />
        <p className="empty-main-area-title">{t("noTabOpen.title")}</p>
        <p className="empty-main-area-hint">{t("noTabOpen.hint")}</p>
      </div>
    </div>
  );
}
