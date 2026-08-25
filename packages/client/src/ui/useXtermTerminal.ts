import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { stripFocusReports } from "../lib/focus-report.js";
import {
  isValidSize,
  shouldSendResize,
  type TerminalSize,
} from "../lib/terminal-fit.js";
import { stripTerminalReplies } from "../lib/terminal-reply.js";
import type { SearchResults } from "../lib/terminal-search.js";
import type { TerminalViewSession } from "./TerminalView.js";
import { handleTerminalKey } from "./terminal-key-handler.js";
import { buildTerminalOptions } from "./terminal-options.js";
import type { XtermRenderer } from "./xterm-renderer.js";

const COPY_DEBOUNCE_MS = 200;

export interface XtermTerminalDeps {
  session: TerminalViewSession;
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<Terminal | null>;
  searchRef: RefObject<SearchAddon | null>;
  fontSize: number;
  renderer: XtermRenderer;
  focusNonce: number;
  resizeNonce: number;
  clipboardEditEnabled: boolean;
  openFind(): void;
  openClipboardEdit(text: string): void;
  resetFind(): void;
  setFindResults(results: SearchResults): void;
}

/**
 * Owns the xterm.js instance lifecycle: construction, measured start/resize, data wiring, and disposal.
 * The session's lifetime is the caller's; on unmount only xterm is disposed. Font size and the
 * clipboard flag are read from refs so a live change updates the running instance without a rebuild.
 */
export function useXtermTerminal({
  session,
  containerRef,
  termRef,
  searchRef,
  fontSize,
  renderer,
  focusNonce,
  resizeNonce,
  clipboardEditEnabled,
  openFind,
  openClipboardEdit,
  resetFind,
  setFindResults,
}: XtermTerminalDeps): void {
  const reassertSizeRef = useRef<() => void>(() => undefined);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const clipboardEditEnabledRef = useRef(clipboardEditEnabled);
  clipboardEditEnabledRef.current = clipboardEditEnabled;

  // Under WKWebView the DOM renderer intermittently drops the first paint on attach (rows exist but
  // stay empty while the buffer holds the content, and a later resize does not reliably repaint); the
  // WebGL renderer paints to a canvas and avoids that race. On context loss it disposes itself and
  // xterm falls back to the DOM renderer; if WebGL is unavailable the constructor throws.
  const enableWebgl = useCallback((term: Terminal): void => {
    if (webglAddonRef.current) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        webglAddonRef.current = null;
      });
      term.loadAddon(webgl);
      webglAddonRef.current = webgl;
    } catch {
      // WebGL unavailable: keep the DOM renderer.
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // A session switch rebuilds the terminal (previous scrollback and decorations are gone), so start
    // from a closed find bar rather than one pointing at a stale buffer.
    resetFind();

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

    if (rendererRef.current === "webgl") enableWebgl(term);

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
    // are still unsettled, the owned PTY gets pinned to 80x24, causing Claude to flap on
    // re-render (endless footer repetition). So we don't start until an actual size is available.
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

    term.attachCustomKeyEventHandler((e) =>
      handleTerminalKey(e, {
        getSelection: () => term.getSelection(),
        input: (data) => session.input(data),
        clipboardEditEnabled: clipboardEditEnabledRef.current,
        openFind,
        openClipboardEdit,
      }),
    );

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
    // OSC color, cursor position) when capabilities are re-queried on window re-attach. At a bare
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
      webglAddonRef.current = null;
      termRef.current = null;
      searchRef.current = null;
      reassertSizeRef.current = () => undefined;
    };
  }, [
    session,
    containerRef,
    termRef,
    searchRef,
    enableWebgl,
    openFind,
    openClipboardEdit,
    resetFind,
    setFindResults,
  ]);

  // Switch renderer without rebuilding the terminal so scrollback and decorations survive: disposing
  // the WebGL addon restores xterm's DOM renderer, and re-adding it returns to WebGL.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (renderer === "webgl") {
      enableWebgl(term);
    } else {
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
    }
  }, [renderer, termRef, enableWebgl]);

  // When focusNonce increments on new session creation, return focus to the terminal.
  // Don't fire on initial mount (initial value 0) or when unchanged. A disposed term is set to
  // termRef=null in cleanup, so we don't touch it.
  const prevFocusNonce = useRef(focusNonce);
  useEffect(() => {
    if (focusNonce === prevFocusNonce.current) return;
    prevFocusNonce.current = focusNonce;
    termRef.current?.focus();
  }, [focusNonce, termRef]);

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
  }, [fontSize, termRef]);
}
