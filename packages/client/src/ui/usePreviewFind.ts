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
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(-1);
  // Only the reader's own moves scroll; re-located matches after a re-read leave the scroll alone.
  const scrollPending = useRef(false);
  const active = open && enabled;

  // biome-ignore lint/correctness/useExhaustiveDependencies: hostKey is a re-run trigger for a remounted host, not read in the body.
  useEffect(() => {
    const host = hostRef.current;
    if (!active || host === null || query === "") {
      setRanges([]);
      return;
    }
    const relocate = () => setRanges(findRanges(host, query));
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
    setIndex((prev) =>
      ranges.length === 0 ? -1 : Math.min(Math.max(prev, 0), ranges.length - 1),
    );
  }, [ranges]);

  const activeRange = index >= 0 ? ranges[index] : undefined;
  useEffect(() => {
    if (!active) return;
    paintHighlights(ranges, activeRange);
    const host = hostRef.current;
    if (scrollPending.current && activeRange && host) {
      scrollPending.current = false;
      scrollToCenter(host, activeRange);
    }
    return clearHighlights;
  }, [active, ranges, activeRange, hostRef]);

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
    scrollPending.current = true;
  }, []);

  const step = useCallback(
    (direction: "next" | "previous") => {
      scrollPending.current = true;
      setIndex((prev) => stepMatchIndex(prev, ranges.length, direction));
    },
    [ranges.length],
  );

  return {
    open: active,
    query,
    results: { resultIndex: index, resultCount: ranges.length },
    toggleFind,
    closeFind,
    onQueryChange,
    step,
  };
}
