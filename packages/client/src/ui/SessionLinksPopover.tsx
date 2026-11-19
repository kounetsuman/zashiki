import type { GithubState, SessionLink, SessionLinkTab } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  filterChips,
  groupLinks,
  type LinkFilter,
  linkIconColor,
  linksInTab,
  linkText,
  selectableFilter,
  tabCounts,
} from "../session/session-links.js";

import "./SessionLinksPopover.css";

const TABS: readonly SessionLinkTab[] = ["conversation", "ai_referenced"];

const TAB_LABEL_KEYS = {
  conversation: "footer.links.tabConversation",
  ai_referenced: "footer.links.tabAiReferenced",
} as const;

const FILTER_LABEL_KEYS = {
  all: "footer.links.filterAll",
  pr: "footer.links.filterPr",
  issue: "footer.links.filterIssue",
  other: "footer.links.filterOther",
} as const;

const GROUP_LABEL_KEYS = {
  pr: "footer.links.groupPr",
  issue: "footer.links.groupIssue",
  other: "footer.links.groupOther",
} as const;

const STATE_LABEL_KEYS = {
  open: "footer.links.stateOpen",
  merged: "footer.links.stateMerged",
  closed: "footer.links.stateClosed",
} as const satisfies Record<GithubState, string>;

const PR_ICON_PATH =
  "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z";

const ISSUE_ICON_PATHS = [
  "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
];

export interface SessionLinksPopoverProps {
  links: readonly SessionLink[];
  onClose(): void;
  onCopy(url: string): void;
}

/**
 * The active Claude Session's links, laid over the terminal without taking it over: no backdrop, no
 * focus trap, and Escape closes it only while focus is inside. It takes focus when it opens and when
 * clicked, because the macOS WebView does not focus a button that is clicked.
 */
export function SessionLinksPopover({
  links,
  onClose,
  onCopy,
}: SessionLinksPopoverProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SessionLinkTab>("conversation");
  const [chosenFilter, setChosenFilter] = useState<LinkFilter>("all");
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    root.current?.focus();
  }, []);

  const counts = tabCounts(links);
  const tabLinks = linksInTab(links, tab);
  const chips = filterChips(tabLinks);
  const filter = selectableFilter(chips, chosenFilter);
  const groups = groupLinks(tabLinks, filter);

  return (
    <section
      className="session-links"
      role="dialog"
      aria-label={t("footer.links.title")}
      ref={root}
      tabIndex={-1}
      onMouseDown={(e) => {
        if (e.currentTarget.contains(document.activeElement)) return;
        e.preventDefault();
        e.currentTarget.focus();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="sl-header">
        <span
          className="material-symbols-outlined sl-header-icon"
          aria-hidden="true"
        >
          link
        </span>
        <h2 className="sl-title">{t("footer.links.title")}</h2>
        <button
          type="button"
          className="sl-icon-button"
          aria-label={t("footer.links.close")}
          onClick={onClose}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            close
          </span>
        </button>
      </header>

      <div className="sl-tabs" role="tablist">
        {TABS.map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            className="sl-tab"
            aria-selected={each === tab}
            onClick={() => {
              setTab(each);
              setChosenFilter("all");
            }}
          >
            {t(TAB_LABEL_KEYS[each])}
            <span className="sl-count">{counts[each]}</span>
          </button>
        ))}
      </div>

      {tabLinks.length === 0 ? (
        <p className="sl-empty">{t("footer.links.empty")}</p>
      ) : (
        <>
          <div className="sl-chips">
            {chips.map((chip) => (
              <button
                key={chip.filter}
                type="button"
                className="sl-chip"
                aria-pressed={chip.filter === filter}
                onClick={() => setChosenFilter(chip.filter)}
              >
                {t(FILTER_LABEL_KEYS[chip.filter])}
                <span className="sl-count">{chip.count}</span>
              </button>
            ))}
          </div>
          <div className="sl-list">
            {groups.map((group) => (
              <section
                key={group.kind}
                aria-label={t(GROUP_LABEL_KEYS[group.kind])}
              >
                <h3 className="sl-group">
                  {t(GROUP_LABEL_KEYS[group.kind])}
                  <span className="sl-group-count">{group.links.length}</span>
                </h3>
                <ul className="sl-rows">
                  {group.links.map((link) => (
                    <LinkRow key={link.url} link={link} onCopy={onCopy} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function LinkRow({
  link,
  onCopy,
}: {
  link: SessionLink;
  onCopy(url: string): void;
}) {
  const { t } = useTranslation();
  const { title, detail } = linkText(link);
  return (
    <li className="sl-row">
      <a
        className="sl-row-link"
        href={link.url}
        target="_blank"
        rel="noreferrer"
      >
        <LinkIcon link={link} />
        <span className="sl-row-text">
          <span className="sl-row-title">{title}</span>
          <span className="sl-row-detail">{detail}</span>
        </span>
      </a>
      <span className="sl-badge">{sourceLabel(link, t)}</span>
      <span className="sl-row-actions">
        <button
          type="button"
          className="sl-icon-button"
          aria-label={t("footer.links.copy")}
          onClick={() => onCopy(link.url)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            content_copy
          </span>
        </button>
        <a
          className="sl-icon-button"
          href={link.url}
          target="_blank"
          rel="noreferrer"
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            open_in_new
          </span>
          <span className="sl-sr-only">{t("footer.links.open")}</span>
        </a>
      </span>
    </li>
  );
}

function sourceLabel(link: SessionLink, t: (key: string) => string): string {
  if (link.tab === "ai_referenced") return link.source;
  return link.source === "user"
    ? t("footer.links.sourceUser")
    : t("footer.links.sourceAssistant");
}

function LinkIcon({ link }: { link: SessionLink }) {
  const { t } = useTranslation();
  if (link.kind === "other") {
    return (
      <span
        className="material-symbols-outlined sl-row-icon"
        aria-hidden="true"
      >
        public
      </span>
    );
  }
  const paths = link.kind === "pr" ? [PR_ICON_PATH] : ISSUE_ICON_PATHS;
  const shapes = paths.map((d) => <path key={d} d={d} fill="currentColor" />);
  const state = link.github?.state;
  const color = linkIconColor(link);
  const svg = {
    className: "sl-row-icon",
    viewBox: "0 0 16 16",
    width: "16",
    height: "16",
    style: color === undefined ? undefined : { color },
  };
  if (state === undefined) {
    return (
      <svg {...svg} aria-hidden="true">
        {shapes}
      </svg>
    );
  }
  const label = t(STATE_LABEL_KEYS[state]);
  return (
    <svg {...svg} role="img" aria-label={label}>
      <title>{label}</title>
      {shapes}
    </svg>
  );
}
