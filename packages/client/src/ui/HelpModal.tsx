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
import { Modal } from "./Modal.js";
import "./HelpModal.css";

export interface HelpModalProps {
  /** The help topics to display (defaults to the bundled content for the active locale). Replaceable in tests. */
  topics?: readonly HelpTopic[];
  /** Category classification (defaults to HELP_CATEGORIES). Replaceable in tests. */
  categories?: readonly HelpCategoryDef[];
  /** Dismiss the modal (Escape, backdrop click, or the close button). */
  onClose(): void;
}

/**
 * User-facing help as a modal, reusing the Settings tabbed layout: the left tabs are the help
 * categories and the body shows the selected category's topics (from content/<locale>/*.md).
 * A non-empty search box replaces the tab selection with the cross-category matches.
 */
export function HelpModal({
  topics,
  categories = HELP_CATEGORIES,
  onClose,
}: HelpModalProps) {
  const { t, i18n } = useTranslation();
  const localizedTopics = useMemo(
    () => topics ?? getHelpTopics(i18n.language),
    [topics, i18n.language],
  );
  const tabs = useMemo(
    () => groupTopics(localizedTopics, categories),
    [localizedTopics, categories],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";

  const activeTab = tabs.find((g) => g.id === activeId) ?? tabs[0];
  const shownTopics = searching
    ? filterTopics(localizedTopics, query)
    : (activeTab?.topics ?? []);

  return (
    <Modal
      title={t("view.help")}
      closeLabel={t("help.close")}
      onClose={onClose}
      className="help-modal"
    >
      <div className="modal-main help-modal-main">
        <div className="modal-nav" role="tablist" aria-orientation="vertical">
          {tabs.map((g) => {
            const active = !searching && activeTab?.id === g.id;
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`modal-nav-item${active ? " is-active" : ""}`}
                onClick={() => {
                  setQuery("");
                  setActiveId(g.id);
                }}
              >
                {t(g.titleKey)}
              </button>
            );
          })}
        </div>
        <div
          className="modal-body help-modal-body scrollbar-persistent"
          role="tabpanel"
        >
          <input
            className="help-search"
            type="text"
            aria-label={t("help.search")}
            placeholder={t("help.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {shownTopics.length === 0 ? (
            <p className="help-empty">{t("help.noResults")}</p>
          ) : (
            <div className="help-topics">
              {shownTopics.map((topic) => (
                <section key={topic.id} aria-label={topic.title}>
                  <h3 className="help-topic-title">{topic.title}</h3>
                  <MarkdownView source={topic.body} />
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
