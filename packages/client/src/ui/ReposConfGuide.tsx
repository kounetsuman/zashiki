import { Trans, useTranslation } from "react-i18next";

/** First-launch guidance when repos.conf is missing/empty (0 orgs). */
export function ReposConfGuide() {
  const { t } = useTranslation();
  return (
    <div className="session-empty-guide">
      <p>{t("sessionList.reposConf.notConfigured")}</p>
      <p>
        <Trans
          i18nKey="sessionList.reposConf.create"
          components={{ code: <code /> }}
        />
      </p>
      <pre>
        {[
          t("sessionList.reposConf.exampleComment"),
          "/Users/you/workspace/org1/repo-a   #7aa2f7",
          "/Users/you/workspace/org2/repo-b",
        ].join("\n")}
      </pre>
      <p>{t("sessionList.reposConf.afterCreate")}</p>
      <p>{t("sessionList.reposConf.seeHelp")}</p>
    </div>
  );
}
