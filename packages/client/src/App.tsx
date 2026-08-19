import {
  type ClientMessage,
  claudeSessionId,
  resumeCommand,
  type ServerMessage,
  type SessionInfo,
  type UpdateCheckResultMessage,
  unreadCount,
} from "@zashiki/shared";
import {
  type FocusEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import type { CrashApi } from "./api/crash.js";
import type { FilesApi } from "./api/files.js";
import type { FsApi } from "./api/fs.js";
import type { GitApi } from "./api/git.js";
import type { ReposApi } from "./api/repos.js";
import type { SearchApi } from "./api/search.js";
import logoUrl from "./assets/logo.png";
import { DebugPanel } from "./debug/DebugPanel.js";
import {
  type ControlDebugSnapshot,
  footerAbnormalNotice,
  resolveDebugInitial,
  type TermDebugSnapshot,
} from "./debug/debug-model.js";
import type { Locale } from "./i18n/detect.js";
import i18n from "./i18n/index.js";
import {
  commitTitle,
  loadConversationTitles,
  saveConversationTitles,
} from "./lib/conversation-title.js";
import { createNotifier, type Notifier } from "./lib/notify.js";
import type { TerminalSessionStatus } from "./session/terminal-session.js";
import { createAppStore } from "./state/app-store.js";
import {
  activateTab,
  activeSessionId,
  activeTab,
  closeTab,
  EMPTY_TABS,
  moveTab,
  openTab,
  pruneSessions,
  tabKey,
} from "./tabs/tab-model.js";
import { AddOrgModal } from "./ui/AddOrgModal.js";
import { CrashReportModal } from "./ui/CrashReportModal.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { ExplorerPanel } from "./ui/ExplorerPanel.js";
import { FooterPanelTabs } from "./ui/FooterPanelTabs.js";
import { GitPanel } from "./ui/GitPanel.js";
import { HelpPanel } from "./ui/HelpPanel.js";
import { LimitIndicator } from "./ui/LimitIndicator.js";
import { NotificationPanel } from "./ui/NotificationPanel.js";
import {
  loadSelectedPanel,
  PANEL_DEFS,
  type PanelId,
  saveSelectedPanel,
} from "./ui/panels.js";
import { SearchPanel } from "./ui/SearchPanel.js";
import { SessionListPanel } from "./ui/SessionListPanel.js";
import { SettingsPanel } from "./ui/SettingsPanel.js";
import { TabBar } from "./ui/TabBar.js";
import { TerminalView, type TerminalViewSession } from "./ui/TerminalView.js";
import { Toaster } from "./ui/Toaster.js";
import { useTerminalFontSize } from "./ui/useTerminalFontSize.js";
import { ViewerPanel } from "./ui/ViewerPanel.js";
import {
  bufferFailed,
  bufferLoaded,
  bufferTogglePreview,
  closeBuffer,
  openBuffer,
  type ViewerBuffers,
  viewerKey,
} from "./viewer/viewer-model.js";
import type { ControlStatus } from "./ws/control.js";

type PanelStorage = Pick<Storage, "getItem" | "setItem">;

function defaultPanelStorage(): PanelStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** Persistence key for seen notification ids (used to compute the unread badge). */
const NOTIFICATIONS_SEEN_KEY = "zk.notifications.seen";

/** Interval for re-reading the file open in the viewer (realtime reflection). */
const FILE_POLL_INTERVAL_MS = 2000;

/** Timeout for a file read (always settles the Promise even if it hangs). */
const FILE_READ_TIMEOUT_MS = 8000;

function readErrorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === "AbortError") {
    return i18n.t("viewer.readTimeout");
  }
  return e instanceof Error ? e.message : String(e);
}

function loadSeenIds(storage: PanelStorage | null): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(NOTIFICATIONS_SEEN_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function saveSeenIds(
  storage: PanelStorage | null,
  ids: readonly string[],
): void {
  storage?.setItem(NOTIFICATIONS_SEEN_KEY, JSON.stringify(ids));
}

export interface AppControl {
  getStatus(): ControlStatus;
  send(msg: ClientMessage): boolean;
  onMessage(fn: (m: ServerMessage) => void): () => void;
  onStatus(fn: (s: ControlStatus) => void): () => void;
  /** Diagnostic display for debug mode. */
  debugSnapshot(): ControlDebugSnapshot;
  onProtocol(fn: (dir: "send" | "recv", t: string) => void): () => void;
}

export interface AppSession extends TerminalViewSession {
  getStatus(): TerminalSessionStatus;
  onStatus(fn: (s: TerminalSessionStatus) => void): () => void;
  /** Diagnostic display for debug mode. */
  debugSnapshot(): TermDebugSnapshot;
  select(windowId: string): void;
  /** Id of the currently attached term (null if not open; used to match unknown_term). */
  getTermId(): string | null;
  /** Re-attaches the pty on term.reconnect (e.g. after a restore). */
  reconnect(): void;
  /** Releases the terminal while there are 0 sessions to stop respawn. */
  suspend(): void;
  /** Re-attaches the terminal when sessions revive. */
  resume(): void;
}

export interface AppProps {
  control: AppControl;
  session: AppSession;
  gitApi: GitApi;
  fsApi: FsApi;
  searchApi: SearchApi;
  /** The viewer's file read REST (read-only). */
  filesApi: FilesApi;
  /** The "add org" REST (registers a directory into repos.conf). */
  reposApi: ReposApi;
  /** Surfaces the previous run's crash log on launch (omitted in tests that don't exercise it). */
  crashApi?: CrashApi;
  /** Notification service (defaults to the real Web Notification + synthesized sound). */
  notifier?: Notifier;
  /** Persistence target for panel selection state (defaults to localStorage). */
  panelStorage?: PanelStorage | null;
  /** Initial on/off for debug mode (resolved from env/URL when omitted). */
  debugInitial?: boolean;
}

/**
 * Error notification. Surfaced to the front rather than buried in the footer.
 * Non-modal (no overlay; does not block interaction behind it) and stays until
 * dismissed via the close button.
 */
function ErrorDialog({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="error-dialog"
      role="alertdialog"
      aria-label={t("errorDialog.label")}
    >
      <div className="error-dialog-head">
        <span className="error-dialog-title" aria-hidden="true">
          {t("errorDialog.title")}
        </span>
        <button
          type="button"
          className="error-dialog-close"
          aria-label={t("common.close")}
          onClick={onDismiss}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            close
          </span>
        </button>
      </div>
      <p className="error-dialog-body">{message}</p>
    </div>
  );
}

/** Empty state shown in the main area when there are no sessions. */
function EmptyMainArea() {
  const { t } = useTranslation();
  return (
    <div className="empty-main-area">
      <div className="empty-main-area-inner">
        <img
          className="empty-main-area-mark"
          src={logoUrl}
          alt=""
          aria-hidden="true"
        />
        <p className="empty-main-area-title">{t("emptyMainArea.title")}</p>
        <p className="empty-main-area-hint">
          <Trans
            i18nKey="emptyMainArea.hint"
            components={{
              plus: <span className="empty-key" />,
              br: <br />,
            }}
          />
        </p>
      </div>
    </div>
  );
}

/** Derives repoPath by subtracting the repo-relative relPath from a SearchFile's absolute path. */
function repoPathOfSearchFile(file: { path: string; relPath: string }): string {
  return file.path
    .slice(0, file.path.length - file.relPath.length)
    .replace(/\/+$/, "");
}

/** Empty state shown when there are sessions but no tab is open. */
function NoTabOpen() {
  const { t } = useTranslation();
  return (
    <div className="empty-main-area">
      <div className="empty-main-area-inner">
        <img
          className="empty-main-area-mark"
          src={logoUrl}
          alt=""
          aria-hidden="true"
        />
        <p className="empty-main-area-title">{t("noTabOpen.title")}</p>
        <p className="empty-main-area-hint">{t("noTabOpen.hint")}</p>
      </div>
    </div>
  );
}

export function App({
  control,
  session,
  gitApi,
  fsApi,
  searchApi,
  filesApi,
  reposApi,
  crashApi,
  notifier: notifierProp,
  panelStorage: panelStorageProp,
  debugInitial,
}: AppProps) {
  const { t } = useTranslation();
  const terminalFont = useTerminalFontSize();
  const [addOrgOpen, setAddOrgOpen] = useState(false);
  const [crashLog, setCrashLog] = useState<string | null>(null);
  const [notifier] = useState(() => notifierProp ?? createNotifier());
  const [panelStorage] = useState(() =>
    panelStorageProp === undefined ? defaultPanelStorage() : panelStorageProp,
  );
  const [selectedPanel, setSelectedPanel] = useState(() =>
    loadSelectedPanel(panelStorage),
  );
  const [conversationTitles, setConversationTitles] = useState(() =>
    loadConversationTitles(panelStorage),
  );
  const [debug, setDebug] = useState(
    () =>
      debugInitial ??
      resolveDebugInitial(
        import.meta.env.VITE_ZK_DEBUG as string | boolean | undefined,
        typeof window === "undefined" ? "" : window.location.search,
      ),
  );

  // Identifier of the active (focus-holding) panel. Follows the focused element up to
  // the nearest data-panel and dims inactive panels.
  // Initially treats the main area as active (avoids dimming every panel).
  const [activePanel, setActivePanel] = useState("main");
  const handlePanelFocus = useCallback((e: FocusEvent<HTMLElement>): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-panel]");
    const id = el?.dataset.panel;
    if (id !== undefined && id !== "") setActivePanel(id);
  }, []);

  // Switch the displayed panel by single selection via the footer icons. Persisted, and
  // activePanel follows the selected panel so the sole displayed panel does not dim even
  // on keyboard switches that do not move focus (consistent with the dimming behavior).
  const handleSelectPanel = useCallback(
    (id: PanelId): void => {
      // Reselecting the displayed panel (re-clicking the icon / re-pressing the same key) closes it.
      const next = selectedPanel === id ? null : id;
      setSelectedPanel(next);
      saveSelectedPanel(panelStorage, next);
      // When closed, treat the now full-height SESSION LIST as active (do not dim it).
      setActivePanel(next ?? "sessions");
    },
    [panelStorage, selectedPanel],
  );

  useEffect(() => {
    if (crashApi === undefined) return;
    let cancelled = false;
    crashApi.last().then(
      (log) => {
        if (!cancelled && log !== null) setCrashLog(log);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [crashApi]);

  // Global switch shortcuts (Ctrl+Alt+<key>). They do not collide with the panel-local
  // Ctrl-N/X (SessionListPanel) because the modifier keys differ.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.altKey || e.metaKey) return;
      // Pass through while a text input (search box, etc.) is focused (e.g. do not close
      // help itself with Ctrl+Alt+H while searching within it). xterm is a textarea, so
      // panel switching while the terminal is focused still works as before.
      if (document.activeElement instanceof HTMLInputElement) return;
      const def = PANEL_DEFS.find((d) => d.shortcutKey === e.key.toLowerCase());
      if (def === undefined) return;
      e.preventDefault();
      handleSelectPanel(def.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSelectPanel]);

  // Toggle debug mode with Ctrl+Alt+D. Its key differs from the panel shortcuts
  // Ctrl+Alt+E/F/G/S, so it does not collide (PANEL_DEFS has no d).
  // Following "while xterm is focused, all keys go to the terminal," pass through while a textarea is being typed in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) return;
      if (
        e.ctrlKey &&
        e.altKey &&
        !e.metaKey &&
        (e.key === "d" || e.key === "D")
      ) {
        e.preventDefault();
        setDebug((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Suppress the WebView's (Tauri WKWebView) native right-click menu.
  // Our custom menus (e.g. right-click on SESSION LIST) are unaffected since they are
  // React-rendered, and the terminal's right-click word selection remains because it
  // works via mouse events.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Interpreting control messages and their side effects (notifications, pty reconnect)
  // is separated into a store outside React; App only subscribes (useSyncExternalStore)
  // and computes derived values.
  const [store] = useState(() =>
    createAppStore({ control, session, notifier }),
  );
  const {
    sessions,
    orgs,
    orgColors,
    notifications,
    lastError,
    selectedWindowId,
    focusNonce,
    resizeNonce,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // Set of seen ids for the unread badge (persisted in localStorage). Notifications are marked read individually by double-click.
  const [seenIds, setSeenIds] = useState(() => loadSeenIds(panelStorage));
  const unread = unreadCount(notifications, seenIds);
  // Number of sessions that have hit the usage limit (input for the footer warning).
  const limitedCount = sessions.filter((s) => s.limited === true).length;
  const markRead = useCallback((id: string) => {
    setSeenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  // Drop seen ids for notifications that are gone (keeps localStorage from growing without bound).
  useEffect(() => {
    const live = new Set(notifications.map((n) => n.id));
    setSeenIds((prev) => {
      const next = prev.filter((id) => live.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [notifications]);
  useEffect(() => {
    saveSeenIds(panelStorage, seenIds);
  }, [seenIds, panelStorage]);
  const controlStatus = useSyncExternalStore(
    useCallback((cb: () => void) => control.onStatus(() => cb()), [control]),
    () => control.getStatus(),
  );
  const termStatus = useSyncExternalStore(
    useCallback((cb: () => void) => session.onStatus(() => cb()), [session]),
    () => session.getStatus(),
  );
  // The unified tab row of the main area. The single source of truth for what is open.
  // Copy the store's selectedWindowId (open request) one-way into openTab, and derive the
  // main-area display and terminal attach from the active session tab (kept one-way to avoid a loop).
  const [tabsState, setTabsState] = useState(EMPTY_TABS);
  const activeSess = activeSessionId(tabsState);

  // Viewer. One viewer tab = one buffer (key matches tab.id).
  const [viewerBuffers, setViewerBuffers] = useState<ViewerBuffers>({});
  const viewerBuffersRef = useRef(viewerBuffers);
  viewerBuffersRef.current = viewerBuffers;
  const active = activeTab(tabsState);
  const activeViewerKey = active?.kind === "viewer" ? active.id : null;
  const activeBuffer =
    activeViewerKey !== null ? (viewerBuffers[activeViewerKey] ?? null) : null;

  // Opener: when the store requests a selection (new session, notification, list double-click),
  // open that session's tab and make it active. The sole entry point for opening a tab.
  useEffect(() => {
    if (selectedWindowId === null) return;
    setTabsState((prev) =>
      openTab(prev, { kind: "session", id: selectedWindowId }),
    );
  }, [selectedWindowId]);

  // Align: match the terminal attach (selectWindow -> session.select) and the store's
  // selection request to the active tab. This is also the path that re-attaches the
  // terminal when active moves to a neighbor on close/prune. selectedWindowId is read via
  // a ref so it is not a dependency, breaking the round-trip with the Opener.
  const selectedRef = useRef(selectedWindowId);
  selectedRef.current = selectedWindowId;
  useEffect(() => {
    if (activeSess !== null) {
      if (selectedRef.current !== activeSess) store.selectWindow(activeSess);
    } else if (selectedRef.current !== null) {
      store.deselect();
    }
  }, [activeSess, store]);

  // Prune: when a session disappears via another client/CLI, thin out its tab too (if the
  // active one is gone, move to the nearest surviving tab in original order). suspend/resume
  // only looks at sessions.length.
  useEffect(() => {
    setTabsState((prev) =>
      pruneSessions(
        prev,
        sessions.map((s) => s.windowId),
      ),
    );
  }, [sessions]);

  // Bootstrap: only on the first pass after startup, if the tabs are empty, open one
  // tmux active window (suppresses empty-state flicker). Once only (does not revive on its
  // own after the user closes all tabs).
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (tabsState.tabs.length > 0) {
      bootstrappedRef.current = true;
      return;
    }
    const w = sessions.find((s) => s.active) ?? sessions[0];
    if (w !== undefined) {
      bootstrappedRef.current = true;
      store.selectWindow(w.windowId);
    }
  }, [sessions, tabsState.tabs.length, store]);

  // Tab activation is funneled from a click (list/tab) into store.selectWindow and
  // reflected into the tab via the Opener. The tab close button only removes the tab (does not kill the session).
  const activateTabByKey = useCallback(
    (key: string): void => {
      const tab = tabsState.tabs.find((t) => tabKey(t) === key);
      if (tab === undefined) return;
      if (tab.kind === "session") store.selectWindow(tab.id);
      else setTabsState((prev) => activateTab(prev, key));
    },
    [tabsState.tabs, store],
  );
  const doCloseTab = useCallback((key: string): void => {
    setTabsState((prev) => closeTab(prev, key));
    setViewerBuffers((prev) => closeBuffer(prev, key));
  }, []);
  const reorderTabByKey = useCallback(
    (fromKey: string, toKey: string): void => {
      setTabsState((prev) => moveTab(prev, fromKey, toKey));
    },
    [],
  );
  // Tab close: no unsaved-changes prompt since it is read-only (both session and viewer close immediately).
  const closeTabByKey = doCloseTab;

  // Generation of each file read (per key). Even if responses are reordered, only the
  // latest generation's read is adopted so an older read does not overwrite newer content (ordering guard).
  const readSeqRef = useRef<Record<string, number>>({});

  // The common read path for open / refresh / polling. Always applies a timeout to read so
  // the Promise settles even if it hangs (avoids getting stuck on "Loading…").
  // silent=true (polling) swallows failures; false (open/refresh) only shows an error when
  // not ready (a transient failure does not clear the currently displayed content).
  const loadFile = useCallback(
    (key: string, repoPath: string, relPath: string, silent: boolean) => {
      const seq = (readSeqRef.current[key] ?? 0) + 1;
      readSeqRef.current[key] = seq;
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), FILE_READ_TIMEOUT_MS);
      return filesApi
        .read(repoPath, relPath, ctrl.signal)
        .then(
          (content) =>
            setViewerBuffers((cur) =>
              readSeqRef.current[key] === seq
                ? bufferLoaded(cur, key, content)
                : cur,
            ),
          (e: unknown) =>
            setViewerBuffers((cur) => {
              if (readSeqRef.current[key] !== seq) return cur;
              if (silent || cur[key]?.status === "ready") return cur;
              return bufferFailed(cur, key, readErrorMessage(e));
            }),
        )
        .finally(() => window.clearTimeout(timer));
    },
    [filesApi],
  );

  // Open a file as a viewer tab (from explorer/search). Fires a read if not yet loaded.
  const openViewer = useCallback(
    (repoPath: string, relPath: string): void => {
      const key = viewerKey(repoPath, relPath);
      setTabsState((prev) => openTab(prev, { kind: "viewer", id: key }));
      let shouldLoad = false;
      setViewerBuffers((prev) => {
        if (prev[key] !== undefined) return prev;
        shouldLoad = true;
        return openBuffer(prev, repoPath, relPath);
      });
      if (shouldLoad) void loadFile(key, repoPath, relPath, false);
    },
    [loadFile],
  );

  const togglePreview = useCallback((key: string): void => {
    setViewerBuffers((prev) => bufferTogglePreview(prev, key));
  }, []);

  // Realtime reflection: re-read the active file at a fixed interval. Since edits happen on
  // the claude code side, external changes are picked up by polling and fed into the display
  // (if the content is unchanged, bufferLoaded returns the same reference and does not re-render).
  // inflight is kept local to this effect and discarded on key switch or unmount (not stuck
  // globally). Failures are swallowed.
  useEffect(() => {
    if (activeViewerKey === null) return;
    const key = activeViewerKey;
    let inflight = false;
    const tick = (): void => {
      if (inflight) return;
      const buf = viewerBuffersRef.current[key];
      if (buf === undefined) return;
      inflight = true;
      void loadFile(key, buf.repoPath, buf.relPath, true).finally(() => {
        inflight = false;
      });
    };
    const id = window.setInterval(tick, FILE_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [activeViewerKey, loadFile]);

  // Commit the conversation header / tab title edit and persist it keyed by windowId (the owned-mode
  // session UUID, preserved across resume/restore). name (repository) is stored alongside for the
  // display-time match. For non-UUID windows (unbound/plain-shell), commitTitle is a no-op.
  const handleCommitConversationTitle = useCallback(
    (windowId: string, name: string, value: string): void => {
      setConversationTitles((prev) => {
        const next = commitTitle(prev, windowId, name, value);
        saveConversationTitles(panelStorage, next);
        return next;
      });
    },
    [panelStorage],
  );

  // Create a new session and, on the immediately following state.sync, auto-switch the
  // main area to the new window (markNewRequested). Shared by both the Cmd+N and list onNew paths.
  const newSession = useCallback(
    (org: string): void => {
      store.markNewRequested();
      control.send({ t: "session.new", org });
    },
    [store, control],
  );

  // A transient toast shown only right after copying to the clipboard. null hides it.
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const copyToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyToastTimer.current !== null) clearTimeout(copyToastTimer.current);
    },
    [],
  );
  const flashCopyToast = useCallback((message: string): void => {
    setCopyToast(message);
    if (copyToastTimer.current !== null) clearTimeout(copyToastTimer.current);
    copyToastTimer.current = setTimeout(() => setCopyToast(null), 1800);
  }, []);

  // Copy the target session's resume command (claude --resume <sid>).
  // Does nothing for a session without a sid (claude not started / undetectable) (the caller disables the menu).
  const copyResume = useCallback(
    (s: SessionInfo | null | undefined): void => {
      const cmd = s == null ? null : resumeCommand(s);
      if (cmd === null) return;
      void navigator.clipboard?.writeText(cmd).then(
        () => flashCopyToast(t("toast.resumeCopied")),
        () => undefined,
      );
    },
    [flashCopyToast, t],
  );

  // Copy the absolute path of the file open in the viewer (the copy button at the left of the header).
  const copyViewerPath = useCallback(
    (key: string): void => {
      const buf = viewerBuffersRef.current[key];
      if (buf === undefined) return;
      void navigator.clipboard
        ?.writeText(`${buf.repoPath}/${buf.relPath}`)
        .then(
          () => flashCopyToast(t("toast.pathCopied")),
          () => undefined,
        );
    },
    [flashCopyToast, t],
  );

  const copyResumeByWindowId = useCallback(
    (windowId: string): void => {
      copyResume(sessions.find((s) => s.windowId === windowId));
    },
    [copyResume, sessions],
  );

  // Copy the target session's Claude Code session id (sid) to the clipboard.
  // Does nothing for a session without a sid (claude not started / undetectable) (the caller disables the menu).
  const copySessionIdByWindowId = useCallback(
    (windowId: string): void => {
      const s = sessions.find((x) => x.windowId === windowId);
      const sid = s == null ? null : claudeSessionId(s);
      if (sid === null) return;
      void navigator.clipboard?.writeText(sid).then(
        () => flashCopyToast(t("toast.sessionIdCopied")),
        () => undefined,
      );
    },
    [flashCopyToast, sessions, t],
  );

  // Always capture Cmd+R for copying the resume command (suppressing reload). meta keys
  // pass through to the browser even while the terminal is focused, so it works (same style
  // as Cmd+N/W). Reload is stopped even when there is no target / no sid to copy (prevents an accidental page reload).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "r" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      e.preventDefault();
      const target = sessions.find((s) => s.windowId === activeSess) ?? null;
      copyResume(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessions, activeSess, copyResume]);

  // With Cmd+N, create a new session in the org of the highlighted session. meta keys are
  // not sent to the pty by xterm but pass through to the browser, so it works even while
  // the terminal is focused (complements Ctrl-N, which only works when a panel is focused).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "n" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      const org =
        sessions.find((s) => s.windowId === activeSess)?.org ?? orgs[0];
      if (org === undefined) return;
      e.preventDefault();
      newSession(org);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessions, orgs, activeSess, newSession]);

  // Close the active tab with Cmd+W (same closeTabByKey path as the tab close button; only removes the
  // tab without killing the session). Like Cmd+N, meta keys pass through to the browser even
  // while the terminal is focused, so it works.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "w" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      const key = tabsState.activeKey;
      if (key === null) return;
      e.preventDefault();
      closeTabByKey(key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabsState.activeKey, closeTabByKey]);

  // When all sessions are removed, release the terminal and stop work regeneration via
  // reconnect. Suspend only on the transition to 0 after having had at least one session
  // (preserves the bootstrap at first startup). Re-attach with resume when they revive.
  const hadSessionsRef = useRef(false);
  useEffect(() => {
    if (sessions.length > 0) {
      hadSessionsRef.current = true;
      session.resume();
    } else if (hadSessionsRef.current) {
      session.suspend();
    }
  }, [sessions.length, session]);

  // Receive settings that apply immediately. The footer toggles are removed; notification
  // sound and debug are driven by the server's config.json (watch -> config.sync). Since the
  // config file is authoritative, URL ?debug=1 and Ctrl+Alt+D are transient overrides that
  // revert to the config value on the next config.sync.
  useEffect(() => {
    return control.onMessage((m) => {
      if (m.t !== "config.sync") return;
      notifier.applyServerConfig(m.notifySound);
      setDebug(m.debug);
      // Apply the display language if the config file has one (unset = null keeps browser detection).
      if (m.language) void i18n.changeLanguage(m.language);
    });
  }, [control, notifier]);

  // Apply a SETTINGS language change immediately and persist it to config.json. After
  // persisting, watch -> config.sync distributes it to all connections, reflecting it in other clients too.
  const saveLanguage = useCallback(
    (language: Locale): void => {
      void i18n.changeLanguage(language);
      control.send({ t: "config.update", language });
    },
    [control],
  );

  // Refetch trigger for the git panel (the hook is emitted server-side).
  const onGitDirty = useCallback(
    (fn: () => void) =>
      control.onMessage((m) => {
        if (m.t === "git.dirty") fn();
      }),
    [control],
  );

  // Manual SESSION LIST refresh: send state.refresh and treat receiving the state.sync
  // addressed to us as completion. Not connected (send=false) / no response (timeout) rejects
  // and turns the panel's header icon into an error.
  const refreshSessions = useCallback(
    (): Promise<void> =>
      new Promise((resolve, reject) => {
        if (!control.send({ t: "state.refresh" })) {
          reject(new Error(t("sessionList.refreshNotConnected")));
          return;
        }
        let unsubscribe = (): void => {};
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(t("sessionList.refreshTimeout")));
        }, 5000);
        unsubscribe = control.onMessage((m) => {
          if (m.t !== "state.sync") return;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        });
      }),
    [control, t],
  );

  // On-demand "Check for updates" (SETTINGS): send update.check and resolve with the server's
  // update.check.result. Not connected (send=false) / no response (timeout) rejects so the panel
  // shows an error. The 15s window covers the server's 10s GitHub request timeout.
  const checkForUpdates = useCallback(
    (): Promise<UpdateCheckResultMessage> =>
      new Promise((resolve, reject) => {
        if (!control.send({ t: "update.check" })) {
          reject(new Error(t("settings.updateError")));
          return;
        }
        let unsubscribe = (): void => {};
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(t("settings.updateError")));
        }, 15000);
        unsubscribe = control.onMessage((m) => {
          if (m.t !== "update.check.result") return;
          clearTimeout(timer);
          unsubscribe();
          resolve(m);
        });
      }),
    [control, t],
  );

  const handleDismissError = (): void => {
    store.clearError();
  };

  // The abnormal notice uses the subscribed controlStatus/termStatus as its re-render
  // trigger and only fills attempt from the snapshot. Since control transitions status every
  // cycle (closed <-> connecting), an attempt update always accompanies a status transition,
  // so this render reads the latest attempt.
  const controlSnap = control.debugSnapshot();
  const abnormal = footerAbnormalNotice(
    {
      status: controlStatus,
      attempt: controlSnap.attempt,
      lastCloseCode: controlSnap.lastCloseCode,
    },
    termStatus,
  );

  return (
    <div className="app">
      <div className="main-row" onFocusCapture={handlePanelFocus}>
        <div
          className={`main-area${activePanel === "main" ? "" : " panel-inactive"}`}
          data-panel="main"
        >
          <TabBar
            tabs={tabsState.tabs}
            activeKey={tabsState.activeKey}
            sessions={sessions}
            conversationTitles={conversationTitles}
            orgColors={orgColors}
            onActivate={activateTabByKey}
            onClose={closeTabByKey}
            onRename={handleCommitConversationTitle}
            onReorder={reorderTabByKey}
            inactive={activePanel !== "main"}
            onCopyResume={copyResumeByWindowId}
            onCopySessionId={copySessionIdByWindowId}
          />
          <div className="tab-panel">
            <ErrorBoundary
              fallback={(error, reset) => (
                <div className="terminal-error" role="alert">
                  <p className="terminal-error-title">
                    {t("terminal.renderError")}
                  </p>
                  <p className="terminal-error-message">{error.message}</p>
                  <button
                    type="button"
                    className="terminal-error-retry"
                    onClick={reset}
                  >
                    {t("common.retry")}
                  </button>
                </div>
              )}
            >
              <TerminalView
                session={session}
                focusNonce={focusNonce}
                resizeNonce={resizeNonce}
                fontSize={terminalFont.fontSize}
              />
            </ErrorBoundary>
            {controlStatus === "open" &&
              sessions.length === 0 &&
              activeViewerKey === null && <EmptyMainArea />}
            {controlStatus === "open" &&
              sessions.length > 0 &&
              activeSess === null &&
              activeViewerKey === null && <NoTabOpen />}
            {activeBuffer !== null && activeViewerKey !== null && (
              <ViewerPanel
                key={activeViewerKey}
                buffer={activeBuffer}
                onTogglePreview={() => togglePreview(activeViewerKey)}
                onCopyPath={() => copyViewerPath(activeViewerKey)}
                inactive={activePanel !== "main"}
              />
            )}
          </div>
        </div>
        <aside className="side-column">
          <SessionListPanel
            sessions={sessions}
            orgs={orgs}
            orgColors={orgColors}
            conversationTitles={conversationTitles}
            connected={controlStatus === "open"}
            selectedWindowId={activeSess}
            onSelect={store.selectWindow}
            onFocusTerminal={store.focusTerminal}
            onNew={newSession}
            onClose={(windowId) =>
              control.send({ t: "session.close", windowId })
            }
            onRefresh={refreshSessions}
            onAddOrg={() => setAddOrgOpen(true)}
            inactive={activePanel !== "sessions"}
            full={selectedPanel === null}
            onCopyResume={copyResumeByWindowId}
            onCopySessionId={copySessionIdByWindowId}
            onRename={handleCommitConversationTitle}
          />
          {selectedPanel === "explorer" && (
            <ExplorerPanel
              api={fsApi}
              orgColors={orgColors}
              onOpenFile={openViewer}
              inactive={activePanel !== "explorer"}
            />
          )}
          {selectedPanel === "search" && (
            <SearchPanel
              api={searchApi}
              orgColors={orgColors}
              onOpen={(file, _line) =>
                openViewer(repoPathOfSearchFile(file), file.relPath)
              }
              inactive={activePanel !== "search"}
            />
          )}
          {selectedPanel === "git" && (
            <GitPanel
              api={gitApi}
              onGitDirty={onGitDirty}
              orgColors={orgColors}
              inactive={activePanel !== "git"}
            />
          )}
          {selectedPanel === "notification" && (
            <NotificationPanel
              notifications={notifications}
              seenIds={seenIds}
              onDismiss={(id) =>
                control.send({ t: "notification.dismiss", id })
              }
              onMarkRead={markRead}
              inactive={activePanel !== "notification"}
            />
          )}
          {selectedPanel === "help" && (
            <HelpPanel inactive={activePanel !== "help"} />
          )}
          {selectedPanel === "settings" && (
            <SettingsPanel
              language={i18n.language}
              onSaveLanguage={saveLanguage}
              fontSize={terminalFont.fontSize}
              onIncreaseFontSize={terminalFont.increase}
              onDecreaseFontSize={terminalFont.decrease}
              onResetFontSize={terminalFont.reset}
              canIncreaseFontSize={terminalFont.canIncrease}
              canDecreaseFontSize={terminalFont.canDecrease}
              canResetFontSize={terminalFont.canReset}
              onAddOrg={() => setAddOrgOpen(true)}
              onCheckForUpdates={checkForUpdates}
              inactive={activePanel !== "settings"}
            />
          )}
        </aside>
      </div>
      {addOrgOpen && (
        <AddOrgModal
          api={reposApi}
          onClose={() => setAddOrgOpen(false)}
          onAdded={(org) => flashCopyToast(t("addOrg.added", { org }))}
        />
      )}
      {crashLog !== null && (
        <CrashReportModal
          log={crashLog}
          onClose={() => {
            setCrashLog(null);
            void crashApi?.ack();
          }}
        />
      )}
      <Toaster notifications={notifications} />
      {copyToast !== null && (
        <div className="copy-toast" role="status" aria-live="polite">
          {copyToast}
        </div>
      )}
      {debug && (
        <DebugPanel
          control={control}
          session={session}
          sessions={sessions}
          onClose={() => setDebug(false)}
        />
      )}
      <footer className="status-bar">
        {abnormal !== null && <span className="status-error">{abnormal}</span>}
        <LimitIndicator count={limitedCount} />
        <FooterPanelTabs
          selected={selectedPanel}
          onSelect={handleSelectPanel}
          badges={{ notification: unread }}
        />
      </footer>
      {lastError !== null && (
        <ErrorDialog message={lastError} onDismiss={handleDismissError} />
      )}
    </div>
  );
}
