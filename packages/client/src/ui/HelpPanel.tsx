import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getHelpTopics, HELP_CATEGORIES } from "../help/help-content.js";
import {
  filterTopics,
  groupTopics,
  type HelpCategoryDef,
  type HelpTopic,
} from "../help/help-model.js";
import { MarkdownView } from "../help/MarkdownView.js";
import { PanelEmpty } from "./PanelEmpty.js";
import { PanelHeader } from "./PanelHeader.js";
import { panelClass } from "./panels.js";

export interface HelpPanelProps {
  /** The help topics to display (defaults to the bundled content for the active locale). Replaceable in tests. */
  topics?: readonly HelpTopic[];
  /** Category classification (defaults to HELP_CATEGORIES). Replaceable in tests. */
  categories?: readonly HelpCategoryDef[];
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
}

/**
 * User-facing help (one panel of NAVIGATION). Topics are imported one file =
 * one topic from content/<locale>/*.md for the active locale and grouped under
 * category headings. The header
 * search filters by title and body (keeping only categories that contain a
 * match), and clicking a heading expands its body as an accordion.
 */
export function HelpPanel({
  topics,
  categories = HELP_CATEGORIES,
  inactive,
}: HelpPanelProps) {
  const { t, i18n } = useTranslation();
  const localizedTopics = useMemo(
    () => topics ?? getHelpTopics(i18n.language),
    [topics, i18n.language],
  );
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const groups = groupTopics(filterTopics(localizedTopics, query), categories);
  // While searching, auto-expand matching topics so the body reveals where the match is.
  const searching = query.trim() !== "";

  const toggle = (id: string): void =>
    setOpenId((prev) => (prev === id ? null : id));

  return (
    <section className={panelClass("help-panel", inactive)} data-panel="help">
      <PanelHeader title="HELP" />
      <div className="help-input-row">
        <input
          className="help-input"
          type="text"
          aria-label={t("help.search")}
          placeholder={t("help.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {groups.length === 0 ? (
        <PanelEmpty>{t("help.noResults")}</PanelEmpty>
      ) : (
        <div className="help-categories">
          {groups.map((g) => {
            const titleId = `help-cat-${g.id}`;
            return (
              <section
                key={g.id}
                className="help-category"
                aria-labelledby={titleId}
              >
                <h2 id={titleId} className="help-category-title">
                  {t(g.titleKey)}
                </h2>
                <div className="help-topics">
                  {g.topics.map((t) => {
                    const open = searching || openId === t.id;
                    const bodyId = `help-body-${t.id}`;
                    return (
                      <div key={t.id} className="help-topic">
                        <button
                          type="button"
                          className="help-topic-header"
                          aria-expanded={open}
                          aria-controls={bodyId}
                          onClick={() => toggle(t.id)}
                        >
                          <span className="help-arrow">{open ? "▼" : "▶"}</span>{" "}
                          <span className="help-topic-title">{t.title}</span>
                        </button>
                        {open && (
                          <section
                            id={bodyId}
                            aria-label={t.title}
                            className="help-topic-body"
                          >
                            <MarkdownView source={t.body} />
                          </section>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
