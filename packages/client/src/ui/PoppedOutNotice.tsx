import { useTranslation } from "react-i18next";

/** Shown over the main terminal while the selected Cockpit Terminal is in its own window. */
export function PoppedOutNotice({
  onShow,
  onReturn,
}: {
  onShow(): void;
  onReturn(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="empty-main-area">
      <div className="empty-main-area-inner">
        <span
          className="material-symbols-outlined popped-out-notice-icon"
          aria-hidden="true"
        >
          open_in_new
        </span>
        <p className="empty-main-area-title">{t("popOut.notice")}</p>
        <div className="popped-out-notice-actions">
          <button type="button" className="pop-out-button" onClick={onShow}>
            <span className="material-symbols-outlined" aria-hidden="true">
              open_in_new
            </span>
            {t("popOut.show")}
          </button>
          <button type="button" className="pop-out-button" onClick={onReturn}>
            <span className="material-symbols-outlined" aria-hidden="true">
              arrow_back
            </span>
            {t("popOut.returnToMain")}
          </button>
        </div>
      </div>
    </div>
  );
}
