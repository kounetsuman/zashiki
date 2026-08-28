import type {
  CockpitTerminalInfo,
  Notification,
  ServerMessage,
} from "@zashiki/shared";

import i18n from "../i18n/index.js";
import type { Notifier } from "../lib/notify.js";
import {
  EMPTY_MEMO,
  editMemo,
  type MemoBuffer,
  syncMemo,
} from "../memo/memo-model.js";
import {
  pruneClosedSessionToasts,
  removeSessionToast,
  type SessionToast,
  upsertSessionToast,
} from "./session-toast-model.js";

/** State the App uses for rendering (the useSyncExternalStore snapshot). */
export interface AppState {
  cockpitTerminals: CockpitTerminalInfo[];
  orgs: string[];
  /** org name -> display color (declared alongside repos.conf). Unspecified orgs are absent and rendered with the default color. */
  orgColors: Record<string, string>;
  /** org name -> display alias (declared alongside repos.conf). Unspecified orgs are absent and rendered by their identity. */
  orgAliases: Record<string, string>;
  /** org name -> free-form Markdown note. Absent orgs have no note. Delivered via notes.sync. */
  orgNotes: Record<string, string>;
  /** The app-wide Memo buffer. Server text arrives via memo.sync; local edits set it dirty. */
  memo: MemoBuffer;
  /** In-app notifications. The server holds them and broadcasts the full set via notifications.sync. */
  notifications: Notification[];
  /** Transient waiting/done session toasts, driven by the notify push and held only client-side. */
  sessionToasts: SessionToast[];
  /** The signed-in Claude account (auth is global per OS user). Delivered via account.status. */
  account: { loggedIn: boolean; email: string | null };
  lastError: string | null;
  selectedCockpitTerminalId: string | null;
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
}

export interface AppStoreDeps {
  control: { onMessage(fn: (m: ServerMessage) => void): () => void };
  session: {
    select(cockpitTerminalId: string): void;
    reconnect(): void;
    /** Id of the currently attached term (null if not open). Used to match against unknown_term. */
    getTermId(): string | null;
  };
  notifier: Notifier;
  /** Brings the tab to the front on toast click (defaults to window.focus; overridden in tests). */
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
  selectCockpitTerminal(cockpitTerminalId: string): void;
  /**
   * Request to move focus to the terminal (advances focusNonce). Called on a
   * list double-click/Enter to return key focus to the already-selected terminal.
   * Kept separate from selectCockpitTerminal so that selections from bootstrap/reordering do
   * not steal focus (preserving the existing design).
   */
  focusTerminal(): void;
  /**
   * Deselects the currently displayed session. Called when all tabs are closed so
   * that a conversation does not linger via the selectedCockpitTerminalId fallback (the active window).
   */
  deselect(): void;
  /**
   * Called when sending session.new. The state.sync that arrives right after
   * auto-selects the newest added window (showing it in the main area the moment a new session is created).
   */
  markNewRequested(): void;
  /** Brings the tab to front and selects the terminal a clicked session toast points at. */
  activateSessionToast(cockpitTerminalId: string): void;
  /** Dismisses a session toast without selecting its terminal (the × button). */
  dismissSessionToast(cockpitTerminalId: string): void;
  /** Dismisses the error dialog (clears lastError originating from a server error). */
  clearError(): void;
  /** Records a local Memo edit (marks the buffer dirty until saved / synced). */
  setMemoText(text: string): void;
}

/**
 * Returns the "newest" cockpitTerminalId among the windows that are in next but not in prev
 * (i.e. newly added). Returns null if there is no addition. Because the cockpitTerminalId
 * shape differs by backend, the rule for "newest" differs too:
 * - legacy (`@N`): monotonically increasing, so the largest number = newest.
 * - owned (UUID): has no ordering, so for a single addition it is that one, and for
 *   multiple simultaneous additions the tail of next (the tail of the server ordering)
 *   is treated as newest. Because cockpitTerminalId became a UUID, number-based logic that assumes
 *   `@N` alone could not auto-select new cockpit terminals. The source of truth is app-store.test.ts.
 */
export function newestAddedCockpitTerminalId(
  prev: readonly CockpitTerminalInfo[],
  next: readonly CockpitTerminalInfo[],
): string | null {
  const prevIds = new Set(prev.map((s) => s.cockpitTerminalId));
  const added = next.filter((s) => !prevIds.has(s.cockpitTerminalId));
  if (added.length === 0) return null;
  if (added.every((s) => /^@\d+$/.test(s.cockpitTerminalId))) {
    let best = added[0]?.cockpitTerminalId ?? null;
    let bestNum = -1;
    for (const s of added) {
      const n = Number(s.cockpitTerminalId.slice(1));
      if (n > bestNum) {
        bestNum = n;
        best = s.cockpitTerminalId;
      }
    }
    return best;
  }
  return added[added.length - 1]?.cockpitTerminalId ?? null;
}

const INITIAL_STATE: AppState = {
  cockpitTerminals: [],
  orgs: [],
  orgColors: {},
  orgAliases: {},
  orgNotes: {},
  memo: EMPTY_MEMO,
  notifications: [],
  sessionToasts: [],
  account: { loggedIn: false, email: null },
  lastError: null,
  selectedCockpitTerminalId: null,
  focusNonce: 0,
  resizeNonce: 0,
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

  function selectCockpitTerminal(cockpitTerminalId: string): void {
    setState({
      selectedCockpitTerminalId: cockpitTerminalId,
      resizeNonce: state.resizeNonce + 1,
      sessionToasts: removeSessionToast(state.sessionToasts, cockpitTerminalId),
    });
    deps.session.select(cockpitTerminalId);
  }

  function activateSessionToast(cockpitTerminalId: string): void {
    (deps.focusWindow ?? (() => window.focus()))();
    selectCockpitTerminal(cockpitTerminalId);
  }

  function dismissSessionToast(cockpitTerminalId: string): void {
    setState({
      sessionToasts: removeSessionToast(state.sessionToasts, cockpitTerminalId),
    });
  }

  function focusTerminal(): void {
    setState({ focusNonce: state.focusNonce + 1 });
  }

  function deselect(): void {
    if (state.selectedCockpitTerminalId === null) return;
    setState({ selectedCockpitTerminalId: null });
  }

  function clearError(): void {
    setState({ lastError: null });
  }

  function setMemoText(text: string): void {
    const memo = editMemo(state.memo, text);
    if (memo !== state.memo) setState({ memo });
  }

  function handleMessage(m: ServerMessage): void {
    if (m.t === "state.sync") {
      const added = pendingNew
        ? newestAddedCockpitTerminalId(
            state.cockpitTerminals,
            m.cockpitTerminals,
          )
        : null;
      const liveIds = new Set(
        m.cockpitTerminals.map((s) => s.cockpitTerminalId),
      );
      const sessionToasts = pruneClosedSessionToasts(
        state.sessionToasts,
        liveIds,
      );
      if (added !== null) {
        pendingNew = false;
        // Move focus to the terminal the moment we auto-switch to the new window.
        // Advance the nonce at the same time as the auto-select so TerminalView reacts.
        setState({
          cockpitTerminals: m.cockpitTerminals,
          orgs: m.orgs,
          orgColors: m.orgColors,
          orgAliases: m.orgAliases,
          selectedCockpitTerminalId: added,
          focusNonce: state.focusNonce + 1,
          resizeNonce: state.resizeNonce + 1,
          sessionToasts: removeSessionToast(sessionToasts, added),
        });
        deps.session.select(added);
      } else {
        setState({
          cockpitTerminals: m.cockpitTerminals,
          orgs: m.orgs,
          orgColors: m.orgColors,
          orgAliases: m.orgAliases,
          sessionToasts,
        });
      }
    } else if (m.t === "notifications.sync") {
      // The full notification list held by the server. Replace it wholesale.
      setState({ notifications: m.items });
    } else if (m.t === "notes.sync") {
      // The full per-org notes map held by the server. Replace it wholesale.
      setState({ orgNotes: m.notes });
    } else if (m.t === "memo.sync") {
      setState({ memo: syncMemo(state.memo, m.text) });
    } else if (m.t === "account.status") {
      setState({ account: { loggedIn: m.loggedIn, email: m.email } });
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
      // Sound + a persistent, click-to-focus session toast, each gated by the category's switch. The
      // terminal being viewed needs no toast.
      deps.notifier.playSound(m.kind);
      if (m.cockpitTerminalId === state.selectedCockpitTerminalId) return;
      if (!deps.notifier.shouldShow(m.kind)) return;
      const info = state.cockpitTerminals.find(
        (s) => s.cockpitTerminalId === m.cockpitTerminalId,
      );
      setState({
        sessionToasts: upsertSessionToast(state.sessionToasts, {
          cockpitTerminalId: m.cockpitTerminalId,
          kind: m.kind,
          org: info ? (state.orgAliases[info.org] ?? info.org) : "",
          title: info?.title ?? null,
        }),
      });
    } else if (m.t === "select") {
      // External focus request (e.g. a clicked desktop notification via /api/focus):
      // bring the app to front and select the window, without a notification. Ignore
      // an already-closed window so we do not select a nonexistent session.
      if (
        !state.cockpitTerminals.some(
          (s) => s.cockpitTerminalId === m.cockpitTerminalId,
        )
      )
        return;
      (deps.focusWindow ?? (() => window.focus()))();
      selectCockpitTerminal(m.cockpitTerminalId);
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
    selectCockpitTerminal,
    focusTerminal,
    deselect,
    activateSessionToast,
    dismissSessionToast,
    markNewRequested() {
      pendingNew = true;
    },
    clearError,
    setMemoText,
  };
}
