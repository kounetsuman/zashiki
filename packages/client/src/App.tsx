import {
  type ClientMessage,
  resolveOrgColor,
  type ServerMessage,
  type UpdateCheckResultMessage,
  unreadCount,
  updateAvailableVersion,
} from "@zashiki/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { CrashApi } from "./api/crash.js";
import type { FilesApi } from "./api/files.js";
import type { FsApi } from "./api/fs.js";
import type { GitApi } from "./api/git.js";
import type { ReposApi } from "./api/repos.js";
import type { SearchApi } from "./api/search.js";
import { DebugView } from "./debug/DebugView.js";
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
import { AddOrgModal } from "./ui/AddOrgModal.js";
import { CockpitTerminalListView } from "./ui/CockpitTerminalListView.js";
import { CrashReportModal } from "./ui/CrashReportModal.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { ErrorDialog } from "./ui/ErrorDialog.js";
import { ExplorerView } from "./ui/ExplorerView.js";
import { FooterViewTabs } from "./ui/FooterViewTabs.js";
import { HelpView } from "./ui/HelpView.js";
import { LimitIndicator } from "./ui/LimitIndicator.js";
import { EmptyMainArea, NoTabOpen } from "./ui/MainAreaEmptyState.js";
import { NotificationView } from "./ui/NotificationView.js";
import { SearchView } from "./ui/SearchView.js";
import { SessionStatusFooter } from "./ui/SessionStatusFooter.js";
import { SettingsView } from "./ui/SettingsView.js";
import { SourceControlView } from "./ui/SourceControlView.js";
import { TabBar } from "./ui/TabBar.js";
import { TerminalView, type TerminalViewSession } from "./ui/TerminalView.js";
import { Toaster } from "./ui/Toaster.js";
import { UpdateBanner } from "./ui/UpdateBanner.js";
import { useAppKeyboardShortcuts } from "./ui/useAppKeyboardShortcuts.js";
import { useAppTabs } from "./ui/useAppTabs.js";
import { useClipboardCopy } from "./ui/useClipboardCopy.js";
import { useClipboardEditEnabled } from "./ui/useClipboardEditEnabled.js";
import { useCopyToast } from "./ui/useCopyToast.js";
import { useCrashReport } from "./ui/useCrashReport.js";
import { useSeenNotifications } from "./ui/useSeenNotifications.js";
import { useTerminalFontSize } from "./ui/useTerminalFontSize.js";
import { useViewer } from "./ui/useViewer.js";
import { useViewSelection } from "./ui/useViewSelection.js";
import { Viewer } from "./ui/Viewer.js";
import type { ControlStatus } from "./ws/control.js";

type ViewStorage = Pick<Storage, "getItem" | "setItem">;

function defaultViewStorage(): ViewStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** Derives repoPath by subtracting the repo-relative relPath from a SearchFile's absolute path. */
function repoPathOfSearchFile(file: { path: string; relPath: string }): string {
  return file.path
    .slice(0, file.path.length - file.relPath.length)
    .replace(/\/+$/, "");
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
  select(cockpitTerminalId: string): void;
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
  /** Persistence target for view selection state (defaults to localStorage). */
  viewStorage?: ViewStorage | null;
  /** Initial on/off for debug mode (resolved from env/URL when omitted). */
  debugInitial?: boolean;
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
  viewStorage: viewStorageProp,
  debugInitial,
}: AppProps) {
  const { t } = useTranslation();
  const terminalFont = useTerminalFontSize();
  const clipboardEdit = useClipboardEditEnabled();
  const [addOrgOpen, setAddOrgOpen] = useState(false);
  const { crashLog, dismissCrash } = useCrashReport(crashApi);
  const [notifier] = useState(() => notifierProp ?? createNotifier());
  const [viewStorage] = useState(() =>
    viewStorageProp === undefined ? defaultViewStorage() : viewStorageProp,
  );
  const [conversationTitles, setConversationTitles] = useState(() =>
    loadConversationTitles(viewStorage),
  );
  const [debug, setDebug] = useState(
    () =>
      debugInitial ??
      resolveDebugInitial(
        import.meta.env.VITE_ZK_DEBUG as string | boolean | undefined,
        typeof window === "undefined" ? "" : window.location.search,
      ),
  );
  const toggleDebug = useCallback(() => setDebug((v) => !v), []);

  const { selectedView, activeView, handleViewFocus, handleSelectView } =
    useViewSelection(viewStorage);

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
    selectedCockpitTerminalId,
    focusNonce,
    resizeNonce,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const { seenIds, markRead } = useSeenNotifications(
    notifications,
    viewStorage,
  );
  const unread = unreadCount(notifications, seenIds);
  const updateVersion = updateAvailableVersion(notifications);
  // Number of sessions that have hit the usage limit (input for the footer warning).
  const limitedCount = sessions.filter((s) => s.limited === true).length;

  const controlStatus = useSyncExternalStore(
    useCallback((cb: () => void) => control.onStatus(() => cb()), [control]),
    () => control.getStatus(),
  );
  const termStatus = useSyncExternalStore(
    useCallback((cb: () => void) => session.onStatus(() => cb()), [session]),
    () => session.getStatus(),
  );

  const {
    tabsState,
    activeSess,
    activeViewerKey,
    activateTabByKey,
    closeTab,
    reorderTabByKey,
    openViewerTab,
  } = useAppTabs(store, sessions, selectedCockpitTerminalId);

  // Footer inputs for the active session tab (undefined for viewer/empty; usage null before a transcript).
  const activeSession =
    activeSess !== null
      ? sessions.find((s) => s.cockpitTerminalId === activeSess)
      : undefined;
  const activeSessionUsage = activeSession?.usage ?? null;
  const activeSessionAccent =
    activeSession !== undefined
      ? resolveOrgColor(activeSession.org, orgColors)
      : undefined;

  const {
    buffers: viewerBuffers,
    ensureBuffer,
    closeBuffer: closeViewerBuffer,
    togglePreview: toggleViewerPreview,
    pathOf: viewerPathOf,
  } = useViewer(filesApi, activeViewerKey);
  const activeBuffer =
    activeViewerKey !== null ? (viewerBuffers[activeViewerKey] ?? null) : null;

  // Open a file as a viewer tab (from explorer/search). ensureBuffer fires a read if not yet loaded.
  const openViewer = useCallback(
    (repoPath: string, relPath: string): void => {
      openViewerTab(ensureBuffer(repoPath, relPath));
    },
    [openViewerTab, ensureBuffer],
  );
  // Tab close removes both the tab and its viewer buffer immediately (read-only, no unsaved-changes prompt).
  const closeTabByKey = useCallback(
    (key: string): void => {
      closeTab(key);
      closeViewerBuffer(key);
    },
    [closeTab, closeViewerBuffer],
  );

  const { copyToast, flashCopyToast } = useCopyToast();
  const {
    copyResume,
    copyResumeByCockpitTerminalId,
    copySessionIdByCockpitTerminalId,
  } = useClipboardCopy(sessions, flashCopyToast);

  // Copy the absolute path of the file open in the viewer (the copy button at the left of the header).
  const copyViewerPath = useCallback(
    (key: string): void => {
      const path = viewerPathOf(key);
      if (path === null) return;
      void navigator.clipboard?.writeText(path).then(
        () => flashCopyToast(t("toast.pathCopied")),
        () => undefined,
      );
    },
    [viewerPathOf, flashCopyToast, t],
  );

  // Commit the conversation header / tab title edit and persist it keyed by cockpitTerminalId (the owned-mode
  // session UUID, preserved across resume/restore). name (repository) is stored alongside for the
  // display-time match. For non-UUID windows (unbound/plain-shell), commitTitle is a no-op.
  const handleCommitConversationTitle = useCallback(
    (cockpitTerminalId: string, name: string, value: string): void => {
      setConversationTitles((prev) => {
        const next = commitTitle(prev, cockpitTerminalId, name, value);
        saveConversationTitles(viewStorage, next);
        return next;
      });
    },
    [viewStorage],
  );

  // Create a new session and, on the immediately following state.sync, auto-switch the
  // main area to the new window (markNewRequested). Shared by both the Cmd+N and list onNew paths.
  const newSession = useCallback(
    (org: string): void => {
      store.markNewRequested();
      control.send({ t: "cockpitTerminal.new", org });
    },
    [store, control],
  );

  useAppKeyboardShortcuts({
    sessions,
    orgs,
    activeSess,
    activeKey: tabsState.activeKey,
    handleSelectView,
    toggleDebug,
    newSession,
    copyResume,
    closeTabByKey,
  });

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

  // Refetch trigger for the git view (the hook is emitted server-side).
  const onGitDirty = useCallback(
    (fn: () => void) =>
      control.onMessage((m) => {
        if (m.t === "git.dirty") fn();
      }),
    [control],
  );

  // Manual SESSION LIST refresh: send state.refresh and treat receiving the state.sync
  // addressed to us as completion. Not connected (send=false) / no response (timeout) rejects
  // and turns the view's header icon into an error.
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
  // update.check.result. Not connected (send=false) / no response (timeout) rejects so the view
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
      <UpdateBanner version={updateVersion} />
      <div className="main-row" onFocusCapture={handleViewFocus}>
        <div
          className={`main-area${activeView === "main" ? "" : " view-inactive"}`}
          data-view="main"
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
            inactive={activeView !== "main"}
            onCopyResume={copyResumeByCockpitTerminalId}
            onCopySessionId={copySessionIdByCockpitTerminalId}
          />
          <div className="tab-view">
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
                clipboardEditEnabled={clipboardEdit.enabled}
                onSetClipboardEditEnabled={clipboardEdit.setEnabled}
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
              <Viewer
                key={activeViewerKey}
                buffer={activeBuffer}
                onTogglePreview={() => toggleViewerPreview(activeViewerKey)}
                onCopyPath={() => copyViewerPath(activeViewerKey)}
                inactive={activeView !== "main"}
              />
            )}
          </div>
          {activeSess !== null && (
            <SessionStatusFooter
              usage={activeSessionUsage}
              accentColor={activeSessionAccent}
            />
          )}
        </div>
        <aside className="side-column">
          <CockpitTerminalListView
            sessions={sessions}
            orgs={orgs}
            orgColors={orgColors}
            conversationTitles={conversationTitles}
            connected={controlStatus === "open"}
            selectedCockpitTerminalId={activeSess}
            onSelect={store.selectCockpitTerminal}
            onFocusTerminal={store.focusTerminal}
            onNew={newSession}
            onClose={(cockpitTerminalId) =>
              control.send({ t: "cockpitTerminal.close", cockpitTerminalId })
            }
            onRefresh={refreshSessions}
            onAddOrg={() => setAddOrgOpen(true)}
            inactive={activeView !== "sessions"}
            full={selectedView === null}
            onCopyResume={copyResumeByCockpitTerminalId}
            onCopySessionId={copySessionIdByCockpitTerminalId}
            onRename={handleCommitConversationTitle}
          />
          {selectedView === "explorer" && (
            <ExplorerView
              api={fsApi}
              orgColors={orgColors}
              onOpenFile={openViewer}
              inactive={activeView !== "explorer"}
            />
          )}
          {selectedView === "search" && (
            <SearchView
              api={searchApi}
              orgColors={orgColors}
              onOpen={(file, _line) =>
                openViewer(repoPathOfSearchFile(file), file.relPath)
              }
              inactive={activeView !== "search"}
            />
          )}
          {selectedView === "sourceControl" && (
            <SourceControlView
              api={gitApi}
              onGitDirty={onGitDirty}
              orgColors={orgColors}
              inactive={activeView !== "sourceControl"}
            />
          )}
          {selectedView === "notification" && (
            <NotificationView
              notifications={notifications}
              seenIds={seenIds}
              onDismiss={(id) =>
                control.send({ t: "notification.dismiss", id })
              }
              onMarkRead={markRead}
              inactive={activeView !== "notification"}
            />
          )}
          {selectedView === "help" && (
            <HelpView inactive={activeView !== "help"} />
          )}
          {selectedView === "settings" && (
            <SettingsView
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
              clipboardEditModal={clipboardEdit.enabled}
              onSetClipboardEditModal={clipboardEdit.setEnabled}
              inactive={activeView !== "settings"}
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
        <CrashReportModal log={crashLog} onClose={dismissCrash} />
      )}
      <Toaster notifications={notifications} />
      {copyToast !== null && (
        <div className="copy-toast" role="status" aria-live="polite">
          {copyToast}
        </div>
      )}
      {debug && (
        <DebugView
          control={control}
          session={session}
          sessions={sessions}
          onClose={() => setDebug(false)}
        />
      )}
      <footer className="status-bar">
        {abnormal !== null && <span className="status-error">{abnormal}</span>}
        <LimitIndicator count={limitedCount} />
        <FooterViewTabs
          selected={selectedView}
          onSelect={handleSelectView}
          badges={{ notification: unread }}
        />
      </footer>
      {lastError !== null && (
        <ErrorDialog message={lastError} onDismiss={handleDismissError} />
      )}
    </div>
  );
}
