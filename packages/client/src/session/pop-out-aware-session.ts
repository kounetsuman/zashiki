import type { AppSession } from "../App.js";

/**
 * The main window's terminal, kept off every Cockpit Terminal that is popped out into its own window.
 * Attaching to one would let the main window's size resize a PTY the pop-out window is drawing, so
 * while the selected terminal is popped out the inner session is parked (suspended), and it
 * re-attaches to the selection once that terminal returns or another one is selected. With
 * `waitForPoppedOut` it stays parked until the first `setPoppedOut`, for a main page that has just
 * reloaded while pop-out windows are open.
 */
export class PopOutAwareSession implements AppSession {
  private poppedOut: ReadonlySet<string> = new Set();
  private selected: string | null = null;
  private parked = false;
  /** Whether the app wants a terminal attached at all (false while there are no cockpit terminals). */
  private wanted = true;
  private poppedOutKnown = true;

  constructor(
    private readonly inner: AppSession,
    { waitForPoppedOut = false }: { waitForPoppedOut?: boolean } = {},
  ) {
    if (waitForPoppedOut) {
      this.poppedOutKnown = false;
      this.park();
    }
  }

  setPoppedOut(ids: ReadonlySet<string>): void {
    this.poppedOut = ids;
    this.poppedOutKnown = true;
    if (this.selected === null) return;
    if (ids.has(this.selected)) this.park();
    else if (this.parked) this.attach(this.selected);
  }

  select(cockpitTerminalId: string): void {
    this.selected = cockpitTerminalId;
    if (!this.poppedOutKnown) return;
    if (this.poppedOut.has(cockpitTerminalId)) this.park();
    else this.attach(cockpitTerminalId);
  }

  suspend(): void {
    this.wanted = false;
    this.inner.suspend();
  }

  resume(): void {
    this.wanted = true;
    if (!this.parked) this.inner.resume();
  }

  private park(): void {
    if (this.parked) return;
    this.parked = true;
    this.inner.suspend();
  }

  private attach(cockpitTerminalId: string): void {
    this.inner.select(cockpitTerminalId);
    if (!this.parked) return;
    this.parked = false;
    if (this.wanted) this.inner.resume();
  }

  start(cols: number, rows: number): void {
    this.inner.start(cols, rows);
  }
  input(data: string): void {
    this.inner.input(data);
  }
  resize(cols: number, rows: number): void {
    this.inner.resize(cols, rows);
  }
  notifyWritten(chars: number): void {
    this.inner.notifyWritten(chars);
  }
  onData(fn: (data: string) => void): () => void {
    return this.inner.onData(fn);
  }
  getStatus(): ReturnType<AppSession["getStatus"]> {
    return this.inner.getStatus();
  }
  onStatus(fn: Parameters<AppSession["onStatus"]>[0]): () => void {
    return this.inner.onStatus(fn);
  }
  debugSnapshot(): ReturnType<AppSession["debugSnapshot"]> {
    return this.inner.debugSnapshot();
  }
  getTermId(): string | null {
    return this.inner.getTermId();
  }
  reconnect(): void {
    this.inner.reconnect();
  }
  retryLostTerm(): void {
    this.inner.retryLostTerm();
  }
}
