import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import { stripFocusReports } from "../lib/focus-report.js";
import {
  isValidSize,
  shouldSendResize,
  type TerminalSize,
} from "../lib/terminal-fit.js";
import { stripTerminalReplies } from "../lib/terminal-reply.js";
import {
  buildSearchOptions,
  centerScrollTop,
  EMPTY_SEARCH_RESULTS,
  type SearchResults,
} from "../lib/terminal-search.js";
import { TerminalFindBar } from "./TerminalFindBar.js";
import { DEFAULT_TERMINAL_FONT_SIZE } from "./terminal-font-size.js";
import { buildTerminalOptions } from "./terminal-options.js";

export interface TerminalViewSession {
  start(cols: number, rows: number): void;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  notifyWritten(chars: number): void;
  onData(fn: (data: string) => void): () => void;
}

const COPY_DEBOUNCE_MS = 200;

/**
 * xterm.js terminal view.
 *
 * - Scrolling natively traverses the scrollback owned by xterm (the wheel is
 *   unaffected by mouseEventsRequireAlt). Scrolling inside a TUI (alternate screen)
 *   is handled by the TUI itself.
 * - Selection uses ordinary drag without modifiers (mouseEventsRequireAlt; even during
 *   mouse tracking, native selection kicks in when Alt is not held) + auto-copy on selection.
 *   Alt-drag performs TUI mouse operations. Right-click selects a word.
 * - The session's lifetime is managed by the caller (on unmount, only xterm is disposed).
 *
 * xterm.js construction options are factored out into buildTerminalOptions (a pure function)
 * and covered by unit tests.
 */
export function TerminalView({
  session,
  focusNonce = 0,
  resizeNonce = 0,
  fontSize = DEFAULT_TERMINAL_FONT_SIZE,
}: {
  session: TerminalViewSession;
  /**
   * Terminal font size in px. Owned by the app (persisted in localStorage) and applied live:
   * changing it updates the running xterm instance and re-fits so cols/rows track the new cell size.
   */
  fontSize?: number;
  /**
   * Request counter for focusing the terminal. Each time it increments, calls term.focus
   * (not on initial mount or when unchanged). app-store advances it when a new session is created.
   */
  focusNonce?: number;
  /**
   * Request counter for re-asserting on window/tab switches. Each time it increments,
   * force-resends a resize at the current view's actual size (unlike applySize's no-op
   * suppression, it sends even when the size is unchanged).
   * A window switch only does select-window and does not resize the pty, and when the
   * `window-size latest` shared window is taken over by another window/client, the RO does not
   * fire because pixels are unchanged, so we reclaim it here.
   */
  resizeNonce?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const reassertSizeRef = useRef<() => void>(() => undefined);

  // In-session find bar (issue #35). Cmd+F while the terminal is focused opens it; the SearchAddon
  // highlights matches, and each match is scrolled to the vertical center.
  const [find, setFind] = useState({ open: false, query: "" });
  const [findResults, setFindResults] =
    useState<SearchResults>(EMPTY_SEARCH_RESULTS);
  const [findFocusSignal, setFindFocusSignal] = useState(0);

  const runSearch = useCallback(
    (query: string, direction: "next" | "previous" | "incremental"): void => {
      const search = searchRef.current;
      const term = termRef.current;
      if (!search || !term) return;
      if (query === "") {
        search.clearDecorations();
        setFindResults(EMPTY_SEARCH_RESULTS);
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
    [],
  );

  const openFind = useCallback((): void => {
    // Prefill from the current selection, but only its first line: the addon searches line by line,
    // so a query containing a newline can never match.
    const selection = (termRef.current?.getSelection() ?? "").split("\n")[0];
    setFind((prev) => ({ open: true, query: selection || prev.query }));
    setFindFocusSignal((n) => n + 1);
  }, []);

  const closeFind = useCallback((): void => {
    searchRef.current?.clearDecorations();
    setFind((prev) => ({ ...prev, open: false }));
    termRef.current?.focus();
  }, []);
  // Latest font size, read (not depended on) by the construction effect so a font change updates the
  // live instance instead of rebuilding the terminal (which would drop scrollback and restart the pty).
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // A session switch rebuilds the terminal (previous scrollback and decorations are gone), so start
    // from a closed find bar rather than one pointing at a stale buffer.
    setFind({ open: false, query: "" });
    setFindResults(EMPTY_SEARCH_RESULTS);

    const term = new Terminal(buildTerminalOptions(fontSizeRef.current));
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Enable the Unicode 11 width table to correctly handle CJK (East Asian full-width = 2 cells).
    // Without it, full-width characters are placed at half-width, so Japanese overflows its cell
    // and appears to "float". Version "11" is only registered after the addon is loaded.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // In-session search (issue #35). onDidChangeResults only fires while decorations are enabled,
    // which the find bar always passes via buildSearchOptions.
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    const offResults = search.onDidChangeResults(setFindResults);
    term.open(el);

    // Render via WebGL instead of xterm's default DOM renderer. Under WKWebView (the packaged app)
    // the DOM renderer intermittently drops the first paint on attach: rows exist but stay empty
    // while the buffer holds the content, and a later resize does not reliably repaint. The WebGL
    // renderer paints to a canvas and is not subject to that DOM first-paint race. On context loss
    // it disposes itself, and xterm falls back to the DOM renderer; if WebGL is unavailable the
    // constructor throws and we keep the DOM renderer (unchanged behavior).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable: keep the DOM renderer.
    }

    // The actual render size, obtainable only once cell dimensions are settled. Right after
    // term.open they are unsettled and proposeDimensions() returns undefined, so this returns null (= not started yet).
    const measure = (): TerminalSize | null => {
      let dims: { cols: number; rows: number } | undefined;
      try {
        dims = fit.proposeDimensions();
      } catch {
        // Environments where dimensions cannot be obtained, e.g. jsdom
        dims = undefined;
      }
      if (!dims || !isValidSize(dims)) return null;
      return { cols: dims.cols, rows: dims.rows };
    };

    let started = false;
    let lastCols = 0;
    let lastRows = 0;

    // Unify start / resize on the measured actual size. If term.open runs at 80x24 while cells
    // are still unsettled, the pty=tmux window gets pinned to 80x24, and in window-size latest
    // environments even other grouped sessions displaying the same window get dragged to 80x24,
    // causing Claude to flap on re-render (endless footer repetition). So we don't start until an actual size is available.
    const applySize = (): void => {
      const size = measure();
      if (!size) return;
      if (!started) {
        started = true;
        lastCols = size.cols;
        lastRows = size.rows;
        term.resize(size.cols, size.rows);
        session.start(size.cols, size.rows);
        return;
      }
      // Don't touch xterm or the session unless fit changes the dimensions (suppresses the
      // spinning loop; since onRender fires every frame, the key is not firing a same-value resize).
      if (!shouldSendResize({ cols: lastCols, rows: lastRows }, size)) return;
      lastCols = size.cols;
      lastRows = size.rows;
      term.resize(size.cols, size.rows);
      session.resize(size.cols, size.rows);
    };

    // On window/tab switches (resizeNonce increment), force-resend a resize at the current view's
    // actual size. Unlike applySize, this does not go through the same-value suppression: even when
    // the shared window is taken by another window/client, the current view's size hasn't changed,
    // so we can't reclaim it without firing on the same value. Don't fire before start or when
    // unmeasured (avoid crushing the shared window with a tiny/unsettled size; reuses the lower-bound check).
    const reassertSize = (): void => {
      if (!started) return;
      const size = measure();
      if (!size) return;
      lastCols = size.cols;
      lastRows = size.rows;
      term.resize(size.cols, size.rows);
      session.resize(size.cols, size.rows);
    };
    reassertSizeRef.current = reassertSize;

    // Start immediately if measurable. If not yet (right after term.open, cells unsettled), defer to the first onRender.
    applySize();
    term.focus();

    // Make Shift+Enter insert a newline via the same meta-return (ESC+CR) as Option+Enter.
    // xterm's default sends a bare CR for Shift+Enter (= submit in Claude Code), so we intercept it.
    // Since xterm does not send Cmd+Right/Left to the pty, we supplement end-of-line (Ctrl-E) /
    // beginning-of-line (Ctrl-A) (macOS Cmd+arrow = end/beginning of line).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // During IME composition, don't intercept; defer to xterm. customKeyEventHandler is called
      // inside xterm before composition handling, and returning false skips compositionHelper.keydown
      // so the committed text is never sent (characters vanish). isComposing can be false around
      // compositionend, so we also check keyCode 229.
      if (e.isComposing || e.keyCode === 229) return true;
      // Cmd+F opens the in-session find bar instead of going to the pty (issue #35). Ctrl+F is left
      // to the shell (readline forward-char); on macOS Cmd is the conventional Find modifier.
      if (
        (e.key === "f" || e.key === "F") &&
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        openFind();
        return false;
      }
      if (
        e.key === "Enter" &&
        e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        session.input("\x1b\r");
        return false;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (e.key === "ArrowRight") {
          session.input("\x05");
          return false;
        }
        if (e.key === "ArrowLeft") {
          session.input("\x01");
          return false;
        }
      }
      return true;
    });

    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCopy = (): void => {
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyTimer = null;
        const text = term.getSelection();
        if (!text) return;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
      }, COPY_DEBOUNCE_MS);
    };

    // xterm sends terminal-generated reports through onData alongside keystrokes: focus reports
    // (ESC[I/ESC[O) when focus tracking is on, and query replies (device attributes, XTVERSION,
    // OSC color, cursor position) when tmux re-queries capabilities on window re-attach. At a bare
    // shell prompt the pty echoes these as garbage, so drop them before sending. If nothing remains
    // after stripping, don't send.
    const disposables = [
      term.onData((d) => {
        const input = stripTerminalReplies(stripFocusReports(d));
        if (input) session.input(input);
      }),
      term.onSelectionChange(scheduleCopy),
    ];
    const offData = session.onData((chunk) => {
      term.write(chunk, () => session.notifyWritten(chunk.length));
    });

    // Cell dimensions are unsettled right after term.open, so the first fit (applySize) is a no-op
    // and cols stays frozen too small (black gap to the right of the main area). TerminalView
    // is a single instance and window switches go through session.select, so useEffect does not
    // re-run and the ResizeObserver does not fire because .terminal-view's pixels don't move. So on
    // the first render (onRender), once cells settle, we re-run applySize: start at the actual size if
    // not started, or resize only the delta if already started.
    let firstRenderRefit: { dispose(): void } | null = null;
    firstRenderRefit = term.onRender(() => {
      applySize();
      // Once started, unsubscribe (subsequent dimension changes are picked up by the ResizeObserver).
      if (started) {
        firstRenderRefit?.dispose();
        firstRenderRefit = null;
      }
    });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => applySize());
      observer.observe(el);
    } else {
      window.addEventListener("resize", applySize);
    }

    return () => {
      if (copyTimer !== null) clearTimeout(copyTimer);
      firstRenderRefit?.dispose();
      observer?.disconnect();
      window.removeEventListener("resize", applySize);
      offData();
      offResults.dispose();
      for (const d of disposables) d.dispose();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
      reassertSizeRef.current = () => undefined;
    };
  }, [session, openFind]);

  // When focusNonce increments on new session creation, return focus to the terminal.
  // Don't fire on initial mount (initial value 0) or when unchanged. A disposed term is set to
  // termRef=null in cleanup, so we don't touch it.
  const prevFocusNonce = useRef(focusNonce);
  useEffect(() => {
    if (focusNonce === prevFocusNonce.current) return;
    prevFocusNonce.current = focusNonce;
    termRef.current?.focus();
  }, [focusNonce]);

  // When resizeNonce increments on a window/tab switch, force-resend a resize at the current view's actual size.
  // Don't fire on initial mount (initial value 0) or when unchanged. A disposed instance is already no-op'd in cleanup.
  const prevResizeNonce = useRef(resizeNonce);
  useEffect(() => {
    if (resizeNonce === prevResizeNonce.current) return;
    prevResizeNonce.current = resizeNonce;
    reassertSizeRef.current();
  }, [resizeNonce]);

  // Apply a font-size change to the live terminal. Not on initial mount (already built with it):
  // the construction effect reads fontSizeRef, so we only handle later changes here. After updating
  // the cell size we re-fit so cols/rows track the new metrics (the ResizeObserver watches the
  // container's pixels, which don't move on a font change, so it wouldn't fire on its own).
  const prevFontSize = useRef(fontSize);
  useEffect(() => {
    if (fontSize === prevFontSize.current) return;
    prevFontSize.current = fontSize;
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    reassertSizeRef.current();
  }, [fontSize]);

  // Drive the search when the bar opens (with a possibly prefilled selection) or the query changes.
  // Explicit next/previous navigation calls runSearch directly and does not touch the query.
  useEffect(() => {
    if (!find.open) return;
    runSearch(find.query, "incremental");
  }, [find.open, find.query, runSearch]);

  return (
    <>
      {find.open && (
        <TerminalFindBar
          query={find.query}
          results={findResults}
          focusSignal={findFocusSignal}
          onQueryChange={(query) => setFind((prev) => ({ ...prev, query }))}
          onNext={() => runSearch(find.query, "next")}
          onPrevious={() => runSearch(find.query, "previous")}
          onClose={closeFind}
        />
      )}
      <div ref={containerRef} className="terminal-view" />
    </>
  );
}
