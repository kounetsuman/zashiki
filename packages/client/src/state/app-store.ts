import type { Notification, ServerMessage, SessionInfo } from "@zashiki/shared";

import i18n from "../i18n/index.js";
import type { Notifier } from "../lib/notify.js";

/** State the App uses for rendering (the useSyncExternalStore snapshot). */
export interface AppState {
  sessions: SessionInfo[];
  orgs: string[];
  /** org name -> display color (declared alongside repos.conf). Unspecified orgs are absent and rendered with the default color. */
  orgColors: Record<string, string>;
  /** In-app notifications. The server holds them and broadcasts the full set via notifications.sync. */
  notifications: Notification[];
  lastError: string | null;
  selectedWindowId: string | null;
  /**
   * Counter for requests to focus the terminal. It increments only when a new
   * session is created and the view auto-switches to the new window. TerminalView detects the change and calls term.focus.
   */
  focusNonce: number;
  /**
   * Re-assert request counter that increments on every window/tab switch. A window
   * switch only does select-window and does not resize the pty, so when the shared
   * `window-size latest` work window is taken over by another client's/window's size,
   * the current view cannot restore it on its own (ResizeObserver does not fire because
   * the pixels of `.terminal-view` do not change). TerminalView detects the change and
   * force-resends a resize at the current view's actual size to reclaim the shared window for the current view.
   */
  resizeNonce: number;
  /**
   * Scrollback-clear request counter that increments on every session switch.
   * Because the same xterm instance is shared across multiple sessions, on a switch
   * the previous session's output remains in the scrollback and becomes visible when
   * scrolling. TerminalView detects the change and calls term.clear() to empty the
   * scrollback. Re-selecting the same windowId does not increment it.
   */
  clearNonce: number;
}

export interface AppStoreDeps {
  control: { onMessage(fn: (m: ServerMessage) => void): () => void };
  session: {
    select(windowId: string): void;
    reconnect(): void;
    /** Id of the currently attached term (null if not open). Used to match against unknown_term. */
    getTermId(): string | null;
  };
  notifier: Notifier;
  /** Brings the tab to the front on notification click (defaults to window.focus; overridden in tests). */
  focusWindow?: () => void;
}

export interface AppStore {
  /**
   * Subscribed from React (useSyncExternalStore). The actual subscription to
   * control is attached on the first subscribe and detached on the last
   * unsubscribe (so StrictMode's double invocation does not leak).
   */
  subscribe(cb: () => void): () => void;
  getSnapshot(): AppState;
  /** Focus jump shared by list clicks and notification clicks. */
  selectWindow(windowId: string): void;
  /**
   * Request to move focus to the terminal (advances focusNonce). Called on a
   * list double-click/Enter to return key focus to the already-selected terminal.
   * Kept separate from selectWindow so that selections from bootstrap/reordering do
   * not steal focus (preserving the existing design).
   */
  focusTerminal(): void;
  /**
   * Deselects the currently displayed session. Called when all tabs are closed so
   * that a conversation does not linger via the selectedWindowId fallback (the tmux active window).
   */
  deselect(): void;
  /**
   * Called when sending session.new. The state.sync that arrives right after
   * auto-selects the newest added window (showing it in the conversation panel the moment a new session is created).
   */
  markNewRequested(): void;
  /** Dismisses the error dialog (clears lastError originating from a server error). */
  clearError(): void;
}

/**
 * Returns the "newest" windowId among the windows that are in next but not in prev
 * (i.e. newly added). Returns null if there is no addition. Because the windowId
 * shape differs by backend, the rule for "newest" differs too:
 * - tmux (`@N`): monotonically increasing, so the largest number = newest.
 * - owned (UUID): has no ordering, so for a single addition it is that one, and for
 *   multiple simultaneous additions the tail of next (the tail of the server ordering)
 *   is treated as newest. Because windowId became a UUID, number-based logic that assumes
 *   `@N` alone could not auto-select new sessions. The source of truth is app-store.test.ts.
 */
export function newestAddedWindowId(
  prev: readonly SessionInfo[],
  next: readonly SessionInfo[],
): string | null {
  const prevIds = new Set(prev.map((s) => s.windowId));
  const added = next.filter((s) => !prevIds.has(s.windowId));
  if (added.length === 0) return null;
  if (added.every((s) => /^@\d+$/.test(s.windowId))) {
    let best = added[0]?.windowId ?? null;
    let bestNum = -1;
    for (const s of added) {
      const n = Number(s.windowId.slice(1));
      if (n > bestNum) {
        bestNum = n;
        best = s.windowId;
      }
    }
    return best;
  }
  return added[added.length - 1]?.windowId ?? null;
}

const INITIAL_STATE: AppState = {
  sessions: [],
  orgs: [],
  orgColors: {},
  notifications: [],
  lastError: null,
  selectedWindowId: null,
  focusNonce: 0,
  resizeNonce: 0,
  clearNonce: 0,
};

/**
 * Store that maps control WS messages into render state and side effects (notifications).
 * Decoupled from React's rendering cycle so the App side only subscribes and computes.
 */
export function createAppStore(deps: AppStoreDeps): AppStore {
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let offControl: (() => void) | null = null;
  // Pending flag held after a session.new request until the added window is auto-selected.
  let pendingNew = false;

  function setState(patch: Partial<AppState>): void {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  }

  function selectWindow(windowId: string): void {
    setState({
      selectedWindowId: windowId,
      resizeNonce: state.resizeNonce + 1,
      ...(windowId !== state.selectedWindowId && state.selectedWindowId !== null
        ? { clearNonce: state.clearNonce + 1 }
        : {}),
    });
    deps.session.select(windowId);
  }

  function focusTerminal(): void {
    setState({ focusNonce: state.focusNonce + 1 });
  }

  function deselect(): void {
    if (state.selectedWindowId === null) return;
    setState({ selectedWindowId: null });
  }

  function clearError(): void {
    setState({ lastError: null });
  }

  function handleMessage(m: ServerMessage): void {
    if (m.t === "state.sync") {
      const added = pendingNew
        ? newestAddedWindowId(state.sessions, m.sessions)
        : null;
      if (added !== null) {
        pendingNew = false;
        // Move focus to the terminal the moment we auto-switch to the new window.
        // Advance the nonce at the same time as the auto-select so TerminalView reacts.
        setState({
          sessions: m.sessions,
          orgs: m.orgs,
          orgColors: m.orgColors,
          selectedWindowId: added,
          focusNonce: state.focusNonce + 1,
          resizeNonce: state.resizeNonce + 1,
          clearNonce:
            state.selectedWindowId !== null
              ? state.clearNonce + 1
              : state.clearNonce,
        });
        deps.session.select(added);
      } else {
        setState({
          sessions: m.sessions,
          orgs: m.orgs,
          orgColors: m.orgColors,
        });
      }
    } else if (m.t === "notifications.sync") {
      // The full notification list held by the server. Replace it wholesale.
      setState({ notifications: m.items });
    } else if (m.t === "term.reconnect") {
      // zk-* was recreated during restore, so reattach the pty.
      deps.session.reconnect();
    } else if (m.t === "error") {
      // Clear the pending flag so a failed session.new request does not linger and mis-select another window.
      pendingNew = false;
      if (m.code === "unknown_term") {
        // A desync where the term registry was lost (e.g. server restart) and term.*
        // targeting an existing termId is rejected. It cannot be fixed by user action,
        // so it is not shown in a dialog; if it targets the current term, reattach with
        // a new termId to re-attach to the restored PTY. A late error targeting the old
        // term after reattaching is ignored to prevent a double reattach.
        const termId = deps.session.getTermId();
        if (termId !== null && m.message.includes(termId)) {
          deps.session.reconnect();
        }
        return;
      }
      // invalid_message means the server could not parse a message this client sent —
      // in practice a client/server version skew (an outdated resident server). Replace the
      // cryptic wire code with an actionable hint instead of showing "invalid_message: ...".
      const lastError =
        m.code === "invalid_message"
          ? i18n.t("errorDialog.outdatedServer")
          : `${m.code}: ${m.message}`;
      setState({ lastError });
    } else if (m.t === "notify") {
      // Web Notification + notification sound. Click brings to front + focus jump.
      const info = state.sessions.find((s) => s.windowId === m.windowId);
      deps.notifier.notify({
        kind: m.kind,
        title: `${i18n.t(m.kind === "waiting" ? "notification.waiting" : "notification.done")} ${m.title}`,
        body: info?.title ?? undefined,
        tag: `zk-${m.windowId}`,
        onClick: () => {
          (deps.focusWindow ?? (() => window.focus()))();
          selectWindow(m.windowId);
        },
      });
    }
  }

  return {
    subscribe(cb) {
      if (listeners.size === 0) {
        offControl = deps.control.onMessage(handleMessage);
      }
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) {
          offControl?.();
          offControl = null;
        }
      };
    },
    getSnapshot: () => state,
    selectWindow,
    focusTerminal,
    deselect,
    markNewRequested() {
      pendingNew = true;
    },
    clearError,
  };
}
