import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { locateMatches, stepMatchIndex } from "../lib/preview-search.js";
import type { SearchResults } from "../lib/terminal-search.js";

const MATCH_HIGHLIGHT = "viewer-find-match";
const ACTIVE_HIGHLIGHT = "viewer-find-active";

export interface PreviewFind {
  open: boolean;
  query: string;
  results: SearchResults;
  toggleFind(): void;
  closeFind(): void;
  onQueryChange(query: string): void;
  step(direction: "next" | "previous"): void;
}

/** Text the reader can read: icon glyph names (`image`, `account_tree`) are drawn, not read. */
function readableTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('[aria-hidden="true"]') ||
      (node.nodeValue ?? "") === ""
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}

function findRanges(root: HTMLElement, query: string): Range[] {
  const nodes = readableTextNodes(root);
  return locateMatches(
    nodes.map((n) => n.nodeValue ?? ""),
    query,
  ).flatMap(({ start, end }) => {
    const startNode = nodes[start.segment];
    const endNode = nodes[end.segment];
    if (!startNode || !endNode) return [];
    const range = document.createRange();
    range.setStart(startNode, start.offset);
    range.setEnd(endNode, end.offset);
    return [range];
  });
}

/** The WebView paints matches through the CSS Custom Highlight API; it is absent under jsdom. */
function paintHighlights(ranges: Range[], active: Range | undefined): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  // Added one by one: spreading tens of thousands of ranges overflows the argument limit.
  const matches = new Highlight();
  for (const range of ranges) matches.add(range);
  CSS.highlights.set(MATCH_HIGHLIGHT, matches);
  if (active) CSS.highlights.set(ACTIVE_HIGHLIGHT, new Highlight(active));
  else CSS.highlights.delete(ACTIVE_HIGHLIGHT);
}

/** Centers the match itself (not its element, which may be a code block taller than the pane). */
function scrollToCenter(host: HTMLElement, range: Range): void {
  const match = range.getBoundingClientRect();
  const pane = host.getBoundingClientRect();
  host.scrollTop += match.top + match.height / 2 - (pane.top + pane.height / 2);
}

function clearHighlights(): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete(MATCH_HIGHLIGHT);
  CSS.highlights.delete(ACTIVE_HIGHLIGHT);
}

/**
 * Find bar for the rendered Markdown preview (Cmd+F). Matches are re-located whenever the preview's
 * DOM changes (a re-read file, a Mermaid diagram drawn later) or `hostKey` names a newly mounted
 * host, and the active one is scrolled to the vertical center.
 */
export function usePreviewFind(
  hostRef: RefObject<HTMLElement | null>,
  hostKey: string,
  enabled: boolean,
): PreviewFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; ranges: Range[] }>({
    query: "",
    ranges: [],
  });
  const [index, setIndex] = useState(-1);
  // Bumped by the reader's own moves only, so re-located matches after a re-read leave the scroll
  // alone; a request is settled once the matches for the current query are in.
  const [scrollRequest, setScrollRequest] = useState(0);
  const settledScrollRequest = useRef(0);
  const active = open && enabled;
  const ranges = found.ranges;
  const activeIndex =
    ranges.length === 0 ? -1 : Math.min(Math.max(index, 0), ranges.length - 1);
  const activeRange = ranges[activeIndex];

  // biome-ignore lint/correctness/useExhaustiveDependencies: hostKey is a re-run trigger for a remounted host, not read in the body.
  useEffect(() => {
    const host = hostRef.current;
    if (!active || host === null || query === "") {
      setFound({ query, ranges: [] });
      return;
    }
    const relocate = () => setFound({ query, ranges: findRanges(host, query) });
    relocate();
    const observer = new MutationObserver(relocate);
    observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [active, query, hostRef, hostKey]);

  useEffect(() => {
    if (!active) return;
    paintHighlights(ranges, activeRange);
    return clearHighlights;
  }, [active, ranges, activeRange]);

  useEffect(() => {
    if (settledScrollRequest.current === scrollRequest) return;
    if (found.query !== query) return;
    settledScrollRequest.current = scrollRequest;
    const host = hostRef.current;
    if (activeRange && host) scrollToCenter(host, activeRange);
  }, [scrollRequest, found, query, activeRange, hostRef]);

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  const closeFind = useCallback(() => {
    setOpen(false);
    hostRef.current?.focus({ preventScroll: true });
  }, [hostRef]);

  const toggleFind = useCallback(() => {
    if (open) closeFind();
    else setOpen(true);
  }, [open, closeFind]);

  const onQueryChange = useCallback((next: string) => {
    setQuery(next);
    setIndex(-1);
    setScrollRequest((n) => n + 1);
  }, []);

  const step = useCallback(
    (direction: "next" | "previous") => {
      setIndex(stepMatchIndex(activeIndex, ranges.length, direction));
      setScrollRequest((n) => n + 1);
    },
    [activeIndex, ranges.length],
  );

  return {
    open: active,
    query,
    results: { resultIndex: activeIndex, resultCount: ranges.length },
    toggleFind,
    closeFind,
    onQueryChange,
    step,
  };
}
