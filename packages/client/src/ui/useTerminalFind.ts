import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { type RefObject, useCallback, useEffect, useState } from "react";
import {
  buildSearchOptions,
  centerScrollTop,
  EMPTY_SEARCH_RESULTS,
  type SearchResults,
} from "../lib/terminal-search.js";

export interface TerminalFind {
  open: boolean;
  query: string;
  results: SearchResults;
  /** Bumped when the bar opens, so the find input can steal focus. */
  focusSignal: number;
  runSearch(
    query: string,
    direction: "next" | "previous" | "incremental",
  ): void;
  openFind(): void;
  closeFind(): void;
  onQueryChange(query: string): void;
  setResults(results: SearchResults): void;
  /** Close the bar and drop results (called when the terminal rebuilds on a session switch). */
  reset(): void;
}

/**
 * In-session find bar (Cmd+F). The SearchAddon highlights matches and each match is scrolled to the
 * vertical center. Explicit next/previous navigation searches directly without touching the query.
 */
export function useTerminalFind(
  termRef: RefObject<Terminal | null>,
  searchRef: RefObject<SearchAddon | null>,
): TerminalFind {
  const [find, setFind] = useState({ open: false, query: "" });
  const [results, setResults] = useState<SearchResults>(EMPTY_SEARCH_RESULTS);
  const [focusSignal, setFocusSignal] = useState(0);

  const runSearch = useCallback(
    (query: string, direction: "next" | "previous" | "incremental"): void => {
      const search = searchRef.current;
      const term = termRef.current;
      if (!search || !term) return;
      if (query === "") {
        search.clearDecorations();
        setResults(EMPTY_SEARCH_RESULTS);
        return;
      }
      const found =
        direction === "previous"
          ? search.findPrevious(query, buildSearchOptions(false))
          : search.findNext(
              query,
              buildSearchOptions(direction === "incremental"),
            );
      if (!found) return;
      const pos = term.getSelectionPosition();
      if (pos) term.scrollToLine(centerScrollTop(pos.start.y, term.rows));
    },
    [searchRef, termRef],
  );

  const openFind = useCallback((): void => {
    // Prefill from the current selection, but only its first line: the addon searches line by line,
    // so a query containing a newline can never match.
    const selection = (termRef.current?.getSelection() ?? "").split("\n")[0];
    setFind((prev) => ({ open: true, query: selection || prev.query }));
    setFocusSignal((n) => n + 1);
  }, [termRef]);

  const closeFind = useCallback((): void => {
    searchRef.current?.clearDecorations();
    setFind((prev) => ({ ...prev, open: false }));
    termRef.current?.focus();
  }, [searchRef, termRef]);

  const onQueryChange = useCallback((query: string): void => {
    setFind((prev) => ({ ...prev, query }));
  }, []);

  const reset = useCallback((): void => {
    setFind({ open: false, query: "" });
    setResults(EMPTY_SEARCH_RESULTS);
  }, []);

  // Drive the search when the bar opens (with a possibly prefilled selection) or the query changes.
  useEffect(() => {
    if (!find.open) return;
    runSearch(find.query, "incremental");
  }, [find.open, find.query, runSearch]);

  return {
    open: find.open,
    query: find.query,
    results,
    focusSignal,
    runSearch,
    openFind,
    closeFind,
    onQueryChange,
    setResults,
    reset,
  };
}
