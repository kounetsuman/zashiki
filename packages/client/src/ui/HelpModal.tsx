import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { getHelpTopics, HELP_CATEGORIES } from "../help/help-content.js";
import {
  filterTopics,
  groupTopics,
  type HelpCategoryDef,
  type HelpTopic,
} from "../help/help-model.js";
import { Highlighted, MarkdownView } from "../help/MarkdownView.js";
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
 * A non-empty search box replaces the tab selection with the cross-category matches. Filtering
 * commits per keystroke, except mid-IME-composition it holds until `compositionend` so the query
 * reflects confirmed text rather than intermediate romaji/kana.
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
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const composing = useRef(false);
  const searching = query.trim() !== "";

  const activeTab = tabs.find((g) => g.id === activeId) ?? tabs[0];
  const shownTopics = searching
    ? filterTopics(localizedTopics, query)
    : (activeTab?.topics ?? []);

  const clearSearch = () => {
    setInput("");
    setQuery("");
  };

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
                  clearSearch();
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
            value={input}
            onChange={(e) => {
              const value = e.target.value;
              setInput(value);
              if (!composing.current) setQuery(value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(e) => {
              composing.current = false;
              const value = e.currentTarget.value;
              setInput(value);
              setQuery(value);
            }}
          />
          {searching && (
            <p className="help-result-count" aria-live="polite">
              {t("help.resultCount", { count: shownTopics.length })}
            </p>
          )}
          {shownTopics.length === 0 ? (
            <p className="help-empty">{t("help.noResults")}</p>
          ) : (
            <div className="help-topics">
              {shownTopics.map((topic) => (
                <section key={topic.id} aria-label={topic.title}>
                  <h3 className="help-topic-title">
                    <Highlighted text={topic.title} query={query} />
                  </h3>
                  <MarkdownView source={topic.body} query={query} />
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
