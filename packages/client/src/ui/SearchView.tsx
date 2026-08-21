import type { SearchFile, SearchResponse } from "@zashiki/shared";
import { resolveOrgColor } from "@zashiki/shared";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SearchApi } from "../api/search.js";
import { ViewEmpty } from "./ViewEmpty.js";
import { ViewHeader } from "./ViewHeader.js";
import { viewClass } from "./views.js";

export interface SearchViewProps {
  api: SearchApi;
  /** org → display color (explicit colors from repos.conf). Unspecified orgs get an auto-assigned color. */
  orgColors?: Record<string, string>;
  /**
   * "Open" target for clicking a result row (the viewer). While the viewer is
   * unfinished, leaving this unspecified means display-only. When specified, the
   * matching file and line are passed to it.
   */
  onOpen?(file: SearchFile, line: number): void;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
}

interface Options {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

const INITIAL_OPTIONS: Options = {
  matchCase: false,
  wholeWord: false,
  regex: false,
};

function totalMatches(res: SearchResponse): number {
  return res.files.reduce((n, f) => n + f.matches.length, 0);
}

export function SearchView({
  api,
  orgColors = {},
  onOpen,
  inactive,
}: SearchViewProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Options>(INITIAL_OPTIONS);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Generation counter to avoid a late, stale response reverting the display.
  const generation = useRef(0);

  const runSearch = useCallback(async (): Promise<void> => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setResult(null);
      setError(null);
      return;
    }
    generation.current += 1;
    const gen = generation.current;
    try {
      const res = await api.search({ query, ...options });
      if (gen !== generation.current) return;
      setResult(res);
      setError(null);
    } catch (err) {
      if (gen === generation.current) {
        setError(String(err));
        setResult(null);
      }
    }
  }, [api, query, options]);

  const toggleOption = (key: keyof Options): void => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleFile = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const optionButton = (key: keyof Options, label: string, title: string) => (
    <button
      type="button"
      className="search-option"
      aria-label={title}
      aria-pressed={options[key]}
      data-active={options[key] ? "true" : "false"}
      title={title}
      onClick={() => toggleOption(key)}
    >
      {label}
    </button>
  );

  const fileBlock = (file: SearchFile) => {
    const open = !collapsed.has(file.path);
    return (
      <div key={file.path} className="search-file">
        <button
          type="button"
          className="search-file-row"
          onClick={() => toggleFile(file.path)}
        >
          <span
            className="search-arrow material-symbols-outlined"
            aria-hidden="true"
          >
            {open ? "expand_more" : "chevron_right"}
          </span>{" "}
          <span className="search-file-name" title={file.path}>
            {file.relPath}
          </span>{" "}
          <span className="search-file-org">
            <span
              className="org-dot"
              role="img"
              style={{ backgroundColor: resolveOrgColor(file.org, orgColors) }}
              title={file.org}
              aria-label={`org: ${file.org}`}
            />{" "}
            {file.repo}
          </span>{" "}
          <span className="search-file-count">{file.matches.length}</span>
        </button>
        {open &&
          file.matches.map((m) => (
            <button
              type="button"
              key={`${m.line}:${m.start}`}
              className="search-match-row"
              title={onOpen ? `${file.relPath}:${m.line}` : undefined}
              disabled={onOpen === undefined}
              onClick={() => onOpen?.(file, m.line)}
            >
              <span className="search-match-line">{m.line}</span>
              <span className="search-match-text">{m.text}</span>
            </button>
          ))}
      </div>
    );
  };

  return (
    <section className={viewClass("search-view", inactive)} data-view="search">
      <ViewHeader title="SEARCH" />
      <div className="search-input-row">
        <input
          className="search-input"
          type="text"
          aria-label={t("search.ariaLabel")}
          placeholder="Search"
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing)
              void runSearch();
          }}
        />
        <span className="search-options">
          {optionButton("matchCase", "Aa", t("search.matchCase"))}
          {optionButton("wholeWord", "ab", t("search.wholeWord"))}
          {optionButton("regex", ".*", t("search.regex"))}
        </span>
      </div>
      {error !== null && <div className="search-error">{error}</div>}
      {result !== null &&
        (result.files.length === 0 ? (
          <ViewEmpty>{t("search.noResults")}</ViewEmpty>
        ) : (
          <div className="search-summary">
            {`${t("search.summary", { matches: totalMatches(result), files: result.files.length })}${result.truncated ? t("search.andMore") : ""}`}
          </div>
        ))}
      <div className="search-tree">{result?.files.map(fileBlock)}</div>
    </section>
  );
}
