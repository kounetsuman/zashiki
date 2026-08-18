import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { matchCounter, type SearchResults } from "../lib/terminal-search.js";

export interface TerminalFindBarProps {
  query: string;
  results: SearchResults;
  /**
   * Incremented each time openFind runs (Cmd+F from the terminal). On change the input is refocused
   * and its text selected, so re-opening from the terminal re-targets the field.
   */
  focusSignal: number;
  onQueryChange(query: string): void;
  onNext(): void;
  onPrevious(): void;
  onClose(): void;
}

/**
 * Browser-style find bar overlaid at the top of the session terminal (issue #35). Presentational:
 * the SearchAddon wiring, highlighting and centering live in TerminalView. Enter / Shift+Enter move
 * between matches, Escape closes.
 */
export function TerminalFindBar({
  query,
  results,
  focusSignal,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: TerminalFindBarProps): React.JSX.Element {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select on mount (the bar just appeared) and each time focusSignal changes (the open
  // shortcut pressed again). Starting the ref at null makes the first render count as a change.
  const prevFocusSignal = useRef<number | null>(null);
  useEffect(() => {
    if (focusSignal === prevFocusSignal.current) return;
    prevFocusSignal.current = focusSignal;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusSignal]);

  const counter = matchCounter(query, results);
  const noMatches = counter !== null && counter.total === 0;
  const counterLabel =
    counter === null
      ? ""
      : noMatches
        ? t("terminal.find.noMatches")
        : `${counter.current} / ${counter.total}`;

  return (
    <search className="terminal-find">
      <input
        ref={inputRef}
        type="text"
        className="terminal-find-input"
        placeholder={t("terminal.find.placeholder")}
        aria-label={t("terminal.find.placeholder")}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrevious();
            else onNext();
          }
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
        title={t("terminal.find.previous")}
        aria-label={t("terminal.find.previous")}
        onClick={onPrevious}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          keyboard_arrow_up
        </span>
      </button>
      <button
        type="button"
        className="terminal-find-btn"
        title={t("terminal.find.next")}
        aria-label={t("terminal.find.next")}
        onClick={onNext}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          keyboard_arrow_down
        </span>
      </button>
      <button
        type="button"
        className="terminal-find-btn"
        title={t("terminal.find.close")}
        aria-label={t("terminal.find.close")}
        onClick={onClose}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          close
        </span>
      </button>
    </search>
  );
}
