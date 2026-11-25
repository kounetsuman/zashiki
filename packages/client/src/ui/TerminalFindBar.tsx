import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { matchCounter, type SearchResults } from "../lib/terminal-search.js";
import { isFindShortcut } from "./terminal-key-handler.js";

export interface TerminalFindBarProps {
  query: string;
  results: SearchResults;
  onQueryChange(query: string): void;
  onNext(): void;
  onPrevious(): void;
  onClose(): void;
  /** Which translation group labels the bar; the terminal's own wording says "in session". */
  labelScope?: "terminal.find" | "find";
}

/**
 * Browser-style find bar overlaid at the top of the session terminal (issue #35). Presentational:
 * the SearchAddon wiring, highlighting and centering live in TerminalView. Enter / Shift+Enter move
 * between matches, Escape and the find shortcut close.
 */
export function TerminalFindBar({
  query,
  results,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
  labelScope = "terminal.find",
}: TerminalFindBarProps): React.JSX.Element {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The bar is mounted only while it is open, so opening it is the moment to take the field.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const counter = matchCounter(query, results);
  const noMatches = counter !== null && counter.total === 0;
  const counterLabel =
    counter === null
      ? ""
      : noMatches
        ? t(`${labelScope}.noMatches` as const)
        : `${counter.current} / ${counter.total}`;

  return (
    <search
      className="terminal-find"
      onKeyDown={(e) => {
        // On the wrapper, not the input: the match buttons take focus when clicked, and dismissing
        // the bar has to keep working from there. The terminal's own handler never sees these keys.
        if (e.nativeEvent.isComposing) return;
        if (!isFindShortcut(e) && e.key !== "Escape") return;
        e.preventDefault();
        onClose();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        className="terminal-find-input"
        placeholder={t(`${labelScope}.placeholder` as const)}
        aria-label={t(`${labelScope}.placeholder` as const)}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (e.shiftKey) onPrevious();
          else onNext();
        }}
      />
      <span
        className={`terminal-find-count${noMatches ? " is-empty" : ""}`}
        aria-live="polite"
      >
        {counterLabel}
      </span>
      <button
        type="button"
        className="terminal-find-btn"
        title={t(`${labelScope}.previous` as const)}
        aria-label={t(`${labelScope}.previous` as const)}
        onClick={onPrevious}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          keyboard_arrow_up
        </span>
      </button>
      <button
        type="button"
        className="terminal-find-btn"
        title={t(`${labelScope}.next` as const)}
        aria-label={t(`${labelScope}.next` as const)}
        onClick={onNext}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          keyboard_arrow_down
        </span>
      </button>
      <button
        type="button"
        className="terminal-find-btn"
        title={t(`${labelScope}.close` as const)}
        aria-label={t(`${labelScope}.close` as const)}
        onClick={onClose}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          close
        </span>
      </button>
    </search>
  );
}
