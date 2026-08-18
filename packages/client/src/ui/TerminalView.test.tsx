// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalView, type TerminalViewSession } from "./TerminalView.js";

const { MockTerminal } = vi.hoisted(() => {
  class MockTerminal {
    static instances: MockTerminal[] = [];
    cols = 80;
    rows = 24;
    openedIn: unknown = null;
    written: string[] = [];
    selection = "";
    disposed = false;
    focusCount = 0;
    clearCount = 0;
    private dataHandler: ((d: string) => void) | null = null;
    private selectionHandler: (() => void) | null = null;
    private keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    private renderHandler: (() => void) | null = null;
    renderDisposed = false;
    unicode = { activeVersion: "6" };
    options: { fontSize?: number } = {};

    constructor(options?: { fontSize?: number }) {
      MockTerminal.instances.push(this);
      if (options) this.options = { ...options };
    }
    loadAddon(addon: { activate?(t: unknown): void }): void {
      addon.activate?.(this);
    }
    open(el: unknown): void {
      this.openedIn = el;
    }
    resizeCount = 0;
    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
      this.resizeCount += 1;
    }
    focus(): void {
      this.focusCount += 1;
    }
    write(d: string, cb?: () => void): void {
      this.written.push(d);
      cb?.();
    }
    onData(fn: (d: string) => void): { dispose(): void } {
      this.dataHandler = fn;
      return { dispose: () => undefined };
    }
    onSelectionChange(fn: () => void): { dispose(): void } {
      this.selectionHandler = fn;
      return { dispose: () => undefined };
    }
    onRender(fn: () => void): { dispose(): void } {
      this.renderHandler = fn;
      return {
        dispose: () => {
          this.renderDisposed = true;
          this.renderHandler = null;
        },
      };
    }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
      this.keyHandler = fn;
    }
    getSelection(): string {
      return this.selection;
    }
    selectionPosition:
      | { start: { x: number; y: number }; end: { x: number; y: number } }
      | undefined = undefined;
    getSelectionPosition() {
      return this.selectionPosition;
    }
    scrollToLineArg: number | null = null;
    scrollToLine(line: number): void {
      this.scrollToLineArg = line;
    }
    clear(): void {
      this.clearCount += 1;
    }
    dispose(): void {
      this.disposed = true;
    }

    emitData(d: string): void {
      this.dataHandler?.(d);
    }
    emitSelectionChange(): void {
      this.selectionHandler?.();
    }
    emitRender(): void {
      this.renderHandler?.();
    }
    emitKey(ev: Partial<KeyboardEvent>): boolean {
      return (
        this.keyHandler?.({
          type: "keydown",
          preventDefault: () => {},
          ...ev,
        } as KeyboardEvent) ?? true
      );
    }
  }
  return { MockTerminal };
});

// Make the behavior where fit() updates term.cols/rows to "values fitted to the available width"
// swappable (reproduces: the first fit is a no-op with unsettled cells -> after onRender it settles and expands).
let fitTarget: { cols: number; rows: number } | null = null;

interface Sizable {
  cols: number;
  rows: number;
}

const { MockWebglAddon } = vi.hoisted(() => {
  class MockWebglAddon {
    static instances = 0;
    disposed = false;
    constructor() {
      MockWebglAddon.instances += 1;
    }
    activate(): void {}
    onContextLoss(): void {}
    dispose(): void {
      this.disposed = true;
    }
  }
  return { MockWebglAddon };
});

const { MockSearchAddon } = vi.hoisted(() => {
  class MockSearchAddon {
    static instances: MockSearchAddon[] = [];
    findNextCalls: Array<{ term: string; options: unknown }> = [];
    findPreviousCalls: Array<{ term: string; options: unknown }> = [];
    clearCount = 0;
    nextResult = false;
    private resultsHandler:
      | ((r: { resultIndex: number; resultCount: number }) => void)
      | null = null;
    constructor() {
      MockSearchAddon.instances.push(this);
    }
    activate(): void {}
    dispose(): void {}
    findNext(term: string, options?: unknown): boolean {
      this.findNextCalls.push({ term, options });
      return this.nextResult;
    }
    findPrevious(term: string, options?: unknown): boolean {
      this.findPreviousCalls.push({ term, options });
      return this.nextResult;
    }
    clearDecorations(): void {
      this.clearCount += 1;
    }
    onDidChangeResults(
      fn: (r: { resultIndex: number; resultCount: number }) => void,
    ): { dispose(): void } {
      this.resultsHandler = fn;
      return {
        dispose: () => {
          this.resultsHandler = null;
        },
      };
    }
    emitResults(r: { resultIndex: number; resultCount: number }): void {
      this.resultsHandler?.(r);
    }
  }
  return { MockSearchAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: MockTerminal }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: MockWebglAddon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: MockSearchAddon }));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    activate(): void {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    private term: Sizable | null = null;
    activate(t: Sizable): void {
      this.term = t;
    }
    fit(): void {
      if (fitTarget && this.term) {
        this.term.cols = fitTarget.cols;
        this.term.rows = fitTarget.rows;
      }
    }
    // Unsettled cells (fitTarget=null) return undefined = reproduces the state where the actual size cannot be obtained.
    proposeDimensions(): { cols: number; rows: number } | undefined {
      return fitTarget
        ? { cols: fitTarget.cols, rows: fitTarget.rows }
        : undefined;
    }
  },
}));

function fakeSession() {
  let dataListener: ((d: string) => void) | null = null;
  const session: TerminalViewSession = {
    start(): void {},
    input(): void {},
    resize(): void {},
    notifyWritten(): void {},
    onData(fn: (d: string) => void): () => void {
      dataListener = fn;
      return () => {
        dataListener = null;
      };
    },
  };
  return {
    session,
    emitData(d: string): void {
      dataListener?.(d);
    },
  };
}

describe("TerminalView", () => {
  beforeEach(() => {
    MockTerminal.instances.length = 0;
    MockWebglAddon.instances = 0;
    MockSearchAddon.instances.length = 0;
    fitTarget = null;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the WebGL renderer (avoids the DOM-renderer first-paint race under WKWebView)", () => {
    fitTarget = { cols: 80, rows: 24 };
    const f = fakeSession();
    render(<TerminalView session={f.session} />);
    expect(MockWebglAddon.instances).toBe(1);
  });

  it("builds the terminal with the given font size", () => {
    fitTarget = { cols: 80, rows: 24 };
    const f = fakeSession();
    render(<TerminalView session={f.session} fontSize={18} />);
    expect(MockTerminal.instances[0]?.options.fontSize).toBe(18);
  });

  it("applies a later font-size change to the live terminal and re-fits even when the fitted size is unchanged", () => {
    fitTarget = { cols: 80, rows: 24 };
    const f = fakeSession();
    const { rerender } = render(
      <TerminalView session={f.session} fontSize={13} />,
    );
    const term = MockTerminal.instances[0];
    expect(term?.options.fontSize).toBe(13);
    const resizeBefore = term?.resizeCount ?? 0;
    // Keep fitTarget the same: a font change must still trigger a re-fit. This guards that the
    // effect actually calls reassertSize (a swapped fitTarget alone would pass without the call).
    rerender(<TerminalView session={f.session} fontSize={20} />);
    expect(term?.options.fontSize).toBe(20);
    expect(term?.resizeCount).toBe(resizeBefore + 1);
  });

  it("re-fit after a font change tracks the new cell dimensions", () => {
    fitTarget = { cols: 80, rows: 24 };
    const f = fakeSession();
    const { rerender } = render(
      <TerminalView session={f.session} fontSize={13} />,
    );
    const term = MockTerminal.instances[0];
    fitTarget = { cols: 100, rows: 30 };
    rerender(<TerminalView session={f.session} fontSize={20} />);
    expect(term?.cols).toBe(100);
    expect(term?.rows).toBe(30);
  });

  it("opens xterm, writes session data, and notifyWritten for the completed portion", () => {
    const f = fakeSession();
    const start = vi.spyOn(f.session, "start");
    const notify = vi.spyOn(f.session, "notifyWritten");
    fitTarget = { cols: 80, rows: 24 }; // assume measurable at mount time
    render(<TerminalView session={f.session} />);

    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");
    expect(term.openedIn).not.toBeNull();
    expect(start).toHaveBeenCalledWith(80, 24);

    f.emitData("hello");
    expect(term.written).toEqual(["hello"]);
    expect(notify).toHaveBeenCalledWith(5);
  });

  it("enables the Unicode11 width table for CJK widths (activeVersion=11)", () => {
    const f = fakeSession();
    render(<TerminalView session={f.session} />);
    expect(MockTerminal.instances[0]?.unicode.activeVersion).toBe("11");
  });

  it("key input (term.onData) flows to session.input", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    MockTerminal.instances[0]?.emitData("ls\r");
    expect(input).toHaveBeenCalledWith("ls\r");
  });

  it("Shift+Enter sends a newline (meta-return \\x1b\\r) and does not submit", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    const handled = term.emitKey({ key: "Enter", shiftKey: true });
    expect(input).toHaveBeenCalledWith("\x1b\r");
    expect(handled).toBe(false);
  });

  it("Cmd+Right sends end-of-line (Ctrl-E \\x05) and suppresses the xterm default", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    const handled = term.emitKey({ key: "ArrowRight", metaKey: true });
    expect(input).toHaveBeenCalledWith("\x05");
    expect(handled).toBe(false);
  });

  it("Cmd+Left sends start-of-line (Ctrl-A \\x01) and suppresses the xterm default", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    const handled = term.emitKey({ key: "ArrowLeft", metaKey: true });
    expect(input).toHaveBeenCalledWith("\x01");
    expect(handled).toBe(false);
  });

  it("plain Right/Left are not intercepted (cursor movement stays xterm->pty)", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");
    expect(term.emitKey({ key: "ArrowRight" })).toBe(true);
    expect(term.emitKey({ key: "ArrowLeft" })).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+Right is not intercepted (does not interfere with selection extension, etc.)", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const handled = MockTerminal.instances[0]?.emitKey({
      key: "ArrowRight",
      metaKey: true,
      shiftKey: true,
    });
    expect(handled).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it("plain Enter is not intercepted (submits as before)", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const handled = MockTerminal.instances[0]?.emitKey({ key: "Enter" });
    expect(handled).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it("Option+Enter is not intercepted (xterm sends meta-return)", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const handled = MockTerminal.instances[0]?.emitKey({
      key: "Enter",
      altKey: true,
    });
    expect(handled).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it("Shift+Enter during IME composition (isComposing) is not intercepted (does not break composition)", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    // Intercepting during composition and returning false skips xterm's compositionHelper.keydown
    // so the committed text is lost. It should pass through (true).
    const handled = term.emitKey({
      key: "Enter",
      shiftKey: true,
      isComposing: true,
    });
    expect(handled).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it("Cmd+Right during IME composition (keyCode 229) is not intercepted", () => {
    const f = fakeSession();
    const input = vi.spyOn(f.session, "input");
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    // isComposing can be false around compositionend, so we also check keyCode 229.
    const handled = term.emitKey({
      key: "ArrowRight",
      metaKey: true,
      keyCode: 229,
    });
    expect(handled).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it("copies automatically on selection", () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const f = fakeSession();
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    term.selection = "copied text";
    term.emitSelectionChange();
    vi.advanceTimersByTime(300);
    expect(writeText).toHaveBeenCalledWith("copied text");
  });

  it("does not copy an empty selection", () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const f = fakeSession();
    render(<TerminalView session={f.session} />);
    MockTerminal.instances[0]?.emitSelectionChange();
    vi.advanceTimersByTime(300);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("disposes xterm on unmount (does not dispose the session)", () => {
    const f = fakeSession();
    const { unmount } = render(<TerminalView session={f.session} />);
    unmount();
    expect(MockTerminal.instances[0]?.disposed).toBe(true);
  });

  it("calls term.focus exactly once on first mount (the initial focusNonce does not trigger an extra focus)", () => {
    const f = fakeSession();
    render(<TerminalView session={f.session} focusNonce={0} />);
    expect(MockTerminal.instances[0]?.focusCount).toBe(1);
  });

  it("calls term.focus again when focusNonce increases (on new session creation)", () => {
    const f = fakeSession();
    const { rerender } = render(
      <TerminalView session={f.session} focusNonce={0} />,
    );
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");
    expect(term.focusCount).toBe(1);
    rerender(<TerminalView session={f.session} focusNonce={1} />);
    expect(term.focusCount).toBe(2);
    rerender(<TerminalView session={f.session} focusNonce={2} />);
    expect(term.focusCount).toBe(3);
  });

  it("does not trigger an extra focus on a re-render where focusNonce is unchanged", () => {
    const f = fakeSession();
    const { rerender } = render(
      <TerminalView session={f.session} focusNonce={1} />,
    );
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");
    expect(term.focusCount).toBe(1);
    rerender(<TerminalView session={f.session} focusNonce={1} />);
    expect(term.focusCount).toBe(1);
  });

  it("does not crash when focusNonce is unspecified and focuses only on first mount (backward compatible)", () => {
    const f = fakeSession();
    render(<TerminalView session={f.session} />);
    expect(MockTerminal.instances[0]?.focusCount).toBe(1);
  });

  it("does not start while cells are unsettled (unmeasurable), avoiding term.open at 80x24", () => {
    const f = fakeSession();
    const start = vi.spyOn(f.session, "start");
    fitTarget = null; // cells unsettled right after term.open -> actual size unavailable
    render(<TerminalView session={f.session} />);
    expect(start).not.toHaveBeenCalled();
  });

  it("does not start while proposeDimensions returns an undersized actual size (tiny frame), so the shared window is not collapsed", () => {
    const f = fakeSession();
    const start = vi.spyOn(f.session, "start");
    // A situation where a mid-layout frame returns a "small but positive integer" actual size rather than undefined.
    fitTarget = { cols: 5, rows: 3 };
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");
    expect(start).not.toHaveBeenCalled();

    // Once layout settles and an actual size is available, start at that size (don't start at a tiny size).
    fitTarget = { cols: 143, rows: 40 };
    term.emitRender();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(143, 40);
  });

  it("does not send resize for an undersized actual-size frame after start, so the shared window is not collapsed", () => {
    const f = fakeSession();
    const resize = vi.spyOn(f.session, "resize");
    fitTarget = { cols: 143, rows: 40 }; // measurable at mount, so start(143,40)
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    // Even if the ResizeObserver/onRender grabs a transient tiny value, don't fire a resize.
    fitTarget = { cols: 4, rows: 2 };
    term.emitRender();
    expect(resize).not.toHaveBeenCalled();
  });

  it("starts at the actual size after cells settle on the first onRender (does not open at 80x24)", () => {
    const f = fakeSession();
    const start = vi.spyOn(f.session, "start");
    const resize = vi.spyOn(f.session, "resize");
    fitTarget = null;
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");
    expect(start).not.toHaveBeenCalled();

    fitTarget = { cols: 143, rows: 40 };
    term.emitRender();
    // Since start carries the actual size, no wasteful 80x24->143x40 resize resend occurs.
    expect(start).toHaveBeenCalledWith(143, 40);
    expect(resize).not.toHaveBeenCalled();
  });

  it("sends resize when the size changes after start (fixes the black gap to the right of the conversation panel)", () => {
    const f = fakeSession();
    const resize = vi.spyOn(f.session, "resize");
    fitTarget = { cols: 100, rows: 30 }; // measurable at mount, so start(100,30)
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    fitTarget = { cols: 143, rows: 40 };
    term.emitRender();
    expect(resize).toHaveBeenCalledWith(143, 40);
  });

  it("does not send resize when the size is unchanged after start (suppresses no-op sends)", () => {
    const f = fakeSession();
    const resize = vi.spyOn(f.session, "resize");
    fitTarget = { cols: 80, rows: 24 };
    render(<TerminalView session={f.session} />);
    MockTerminal.instances[0]?.emitRender(); // no change
    expect(resize).not.toHaveBeenCalled();
  });

  it("force-resends resize at the current view's actual size when resizeNonce increases (reclaims the shared window even when the size is unchanged)", () => {
    const f = fakeSession();
    const resize = vi.spyOn(f.session, "resize");
    fitTarget = { cols: 143, rows: 40 }; // start(143,40) at mount
    const { rerender } = render(
      <TerminalView session={f.session} resizeNonce={0} />,
    );
    // Unlike the no-op suppression in applySize, on window/tab switches we resend even for the same value.
    rerender(<TerminalView session={f.session} resizeNonce={1} />);
    expect(resize).toHaveBeenCalledWith(143, 40);
  });

  it("does not resend resize for the initial or unchanged resizeNonce", () => {
    const f = fakeSession();
    const resize = vi.spyOn(f.session, "resize");
    fitTarget = { cols: 143, rows: 40 };
    const { rerender } = render(
      <TerminalView session={f.session} resizeNonce={0} />,
    );
    rerender(<TerminalView session={f.session} resizeNonce={0} />);
    expect(resize).not.toHaveBeenCalled();
  });

  it("does not resize on a resizeNonce increase before start (unmeasured, so the shared window is not collapsed)", () => {
    const f = fakeSession();
    const resize = vi.spyOn(f.session, "resize");
    fitTarget = null; // cells unsettled, not started
    const { rerender } = render(
      <TerminalView session={f.session} resizeNonce={0} />,
    );
    rerender(<TerminalView session={f.session} resizeNonce={1} />);
    expect(resize).not.toHaveBeenCalled();
  });

  it("starts only once (does not double-start even across multiple onRenders)", () => {
    const f = fakeSession();
    const start = vi.spyOn(f.session, "start");
    fitTarget = null;
    render(<TerminalView session={f.session} />);
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");

    fitTarget = { cols: 100, rows: 30 };
    term.emitRender();
    expect(start).toHaveBeenCalledTimes(1);
    expect(term.renderDisposed).toBe(true);

    // After start, the onRender subscription is disposed. Subsequent onRenders don't re-start.
    fitTarget = { cols: 200, rows: 60 };
    term.emitRender();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("after a StrictMode double mount, a focusNonce increase focuses only the live term (does not touch the disposed one)", () => {
    const f = fakeSession();
    const { rerender } = render(
      <StrictMode>
        <TerminalView session={f.session} focusNonce={0} />
      </StrictMode>,
    );
    // StrictMode: mount->cleanup (first is disposed)->mount (the second survives).
    const disposed = MockTerminal.instances[0];
    const live = MockTerminal.instances.at(-1);
    if (!disposed || !live) throw new Error("terminals not created");
    expect(disposed.disposed).toBe(true);
    expect(live.disposed).toBe(false);
    const disposedFocusBefore = disposed.focusCount;

    rerender(
      <StrictMode>
        <TerminalView session={f.session} focusNonce={1} />
      </StrictMode>,
    );
    expect(live.focusCount).toBeGreaterThan(0);
    // Focus on a disposed instance does not increase (termRef was nulled in cleanup).
    expect(disposed.focusCount).toBe(disposedFocusBefore);
  });

  it("calls term.clear() when clearNonce increases (prevents scrollback pollution on session switch)", () => {
    const f = fakeSession();
    fitTarget = { cols: 80, rows: 24 };
    const { rerender } = render(
      <TerminalView session={f.session} clearNonce={0} />,
    );
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");
    expect(term.clearCount).toBe(0);
    rerender(<TerminalView session={f.session} clearNonce={1} />);
    expect(term.clearCount).toBe(1);
    rerender(<TerminalView session={f.session} clearNonce={2} />);
    expect(term.clearCount).toBe(2);
  });

  it("does not call term.clear() for the initial or unchanged clearNonce", () => {
    const f = fakeSession();
    fitTarget = { cols: 80, rows: 24 };
    const { rerender } = render(
      <TerminalView session={f.session} clearNonce={0} />,
    );
    const term = MockTerminal.instances[0];
    if (!term) throw new Error("terminal not created");
    rerender(<TerminalView session={f.session} clearNonce={0} />);
    expect(term.clearCount).toBe(0);
  });

  it("does not crash when clearNonce is unspecified", () => {
    const f = fakeSession();
    render(<TerminalView session={f.session} />);
    expect(MockTerminal.instances[0]?.clearCount).toBe(0);
  });

  describe("in-session find bar (issue #35)", () => {
    const PLACEHOLDER = "セッション内を検索";

    function renderStarted() {
      fitTarget = { cols: 80, rows: 24 };
      const f = fakeSession();
      render(<TerminalView session={f.session} />);
      const term = MockTerminal.instances[0];
      if (!term) throw new Error("terminal not created");
      return { term, session: f.session };
    }

    it("opens on Cmd+F and swallows the key (does not forward to the pty)", () => {
      const { term } = renderStarted();
      let forwarded = true;
      act(() => {
        forwarded = term.emitKey({ key: "f", metaKey: true });
      });
      expect(forwarded).toBe(false);
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
    });

    it("prefills the query from the selection's first line only (newlines never match)", () => {
      const { term } = renderStarted();
      term.selection = "foo\nbar";
      act(() => term.emitKey({ key: "f", metaKey: true }));
      expect(
        (screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement).value,
      ).toBe("foo");
    });

    it("does not open on Ctrl+F (left to the shell's forward-char)", () => {
      const { term } = renderStarted();
      let forwarded = false;
      act(() => {
        forwarded = term.emitKey({ key: "f", ctrlKey: true });
      });
      expect(forwarded).toBe(true);
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
    });

    it("runs an incremental search while typing", () => {
      const { term } = renderStarted();
      act(() => term.emitKey({ key: "f", metaKey: true }));
      fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
        target: { value: "foo" },
      });
      const search = MockSearchAddon.instances[0];
      if (!search) throw new Error("search addon not loaded");
      expect(search.findNextCalls.at(-1)?.term).toBe("foo");
      expect(search.findNextCalls.at(-1)?.options).toMatchObject({
        incremental: true,
      });
    });

    it("navigates with Enter (non-incremental) and centers the match", () => {
      const { term } = renderStarted();
      const search = MockSearchAddon.instances[0];
      if (!search) throw new Error("search addon not loaded");
      search.nextResult = true;
      term.selectionPosition = {
        start: { x: 1, y: 100 },
        end: { x: 5, y: 100 },
      };
      act(() => term.emitKey({ key: "f", metaKey: true }));
      const input = screen.getByPlaceholderText(PLACEHOLDER);
      fireEvent.change(input, { target: { value: "foo" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(search.findNextCalls.at(-1)?.options).toMatchObject({
        incremental: false,
      });
      // rows 24, match on 1-based line 100 => scroll top to 100 - 1 - 12 = 87
      expect(term.scrollToLineArg).toBe(87);
    });

    it("navigates backwards with Shift+Enter", () => {
      const { term } = renderStarted();
      const search = MockSearchAddon.instances[0];
      if (!search) throw new Error("search addon not loaded");
      act(() => term.emitKey({ key: "f", metaKey: true }));
      const input = screen.getByPlaceholderText(PLACEHOLDER);
      fireEvent.change(input, { target: { value: "foo" } });
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      expect(search.findPreviousCalls.at(-1)?.term).toBe("foo");
    });

    it("closes on Escape, clearing decorations and refocusing the terminal", () => {
      const { term } = renderStarted();
      const search = MockSearchAddon.instances[0];
      if (!search) throw new Error("search addon not loaded");
      act(() => term.emitKey({ key: "f", metaKey: true }));
      const focusBefore = term.focusCount;
      fireEvent.keyDown(screen.getByPlaceholderText(PLACEHOLDER), {
        key: "Escape",
      });
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
      expect(search.clearCount).toBeGreaterThan(0);
      expect(term.focusCount).toBeGreaterThan(focusBefore);
    });
  });
});
