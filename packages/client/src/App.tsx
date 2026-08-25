import {
  type ClientMessage,
  claudeSessionId,
  DEFAULT_FOOTER_THRESHOLDS,
  type FooterThresholds,
  type HooksStatusMessage,
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
  type TermDebugSnapshot,
} from "./debug/debug-model.js";
import { diffSide } from "./diff/diff-model.js";
import type { Locale } from "./i18n/detect.js";
import i18n from "./i18n/index.js";
import {
  commitTitle,
  loadConversationTitles,
  saveConversationTitles,
} from "./lib/conversation-title.js";
import {
  loadFirstRunWizardSeen,
  saveFirstRunWizardSeen,
  shouldShowFirstRunWizard,
} from "./lib/first-run-wizard.js";
import { createNotifier, type Notifier } from "./lib/notify.js";
import { canOpenDevtools, openDevtools } from "./lib/tauri-devtools.js";
import {
  fmtResetClock,
  pickAccountLimits,
  usageRemainingPercent,
} from "./session/status-footer.js";
import type { TermAttachStatus } from "./session/terminal-session.js";
import { createAppStore } from "./state/app-store.js";
import { tabKey } from "./tabs/tab-model.js";
import { AccountIndicator } from "./ui/AccountIndicator.js";
import { AccountUsageFooter } from "./ui/AccountUsageFooter.js";
import { AccountUsageModal } from "./ui/AccountUsageModal.js";
import { AddOrgModal } from "./ui/AddOrgModal.js";
import { CockpitTerminalListView } from "./ui/CockpitTerminalListView.js";
import { CrashReportModal } from "./ui/CrashReportModal.js";
import { DiffView } from "./ui/DiffView.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { ErrorDialog } from "./ui/ErrorDialog.js";
import { ExplorerView } from "./ui/ExplorerView.js";
import { FirstRunSetupWizard } from "./ui/FirstRunSetupWizard.js";
import { FooterSettingsButton } from "./ui/FooterSettingsButton.js";
import { FooterViewTabs } from "./ui/FooterViewTabs.js";
import { HelpView } from "./ui/HelpView.js";
import { LimitIndicator } from "./ui/LimitIndicator.js";
import { EmptyMainArea, NoTabOpen } from "./ui/MainAreaEmptyState.js";
import { NotificationView } from "./ui/NotificationView.js";
import { SearchView } from "./ui/SearchView.js";
import { SessionStatusFooter } from "./ui/SessionStatusFooter.js";
import { SettingsModal } from "./ui/SettingsModal.js";
import { SourceControlView } from "./ui/SourceControlView.js";
import { TabBar } from "./ui/TabBar.js";
import { TerminalView, type TerminalViewSession } from "./ui/TerminalView.js";
import { Toaster } from "./ui/Toaster.js";
import { UpdateBanner } from "./ui/UpdateBanner.js";
import { UsageLimitWarningDialog } from "./ui/UsageLimitWarningDialog.js";
import { useAppKeyboardShortcuts } from "./ui/useAppKeyboardShortcuts.js";
import { useAppTabs } from "./ui/useAppTabs.js";
import { useClipboardCopy } from "./ui/useClipboardCopy.js";
import { useClipboardEditEnabled } from "./ui/useClipboardEditEnabled.js";
import { useCopyToast } from "./ui/useCopyToast.js";
import { useCrashReport } from "./ui/useCrashReport.js";
import { useDiff } from "./ui/useDiff.js";
import { useSeenNotifications } from "./ui/useSeenNotifications.js";
import { useSelfUpdate } from "./ui/useSelfUpdate.js";
import { useTerminalFontSize } from "./ui/useTerminalFontSize.js";
import { useUsageLimitWarning } from "./ui/useUsageLimitWarning.js";
import { useViewer } from "./ui/useViewer.js";
import { useViewSelection } from "./ui/useViewSelection.js";
import { useXtermRenderer } from "./ui/useXtermRenderer.js";
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
  getStatus(): TermAttachStatus;
  onStatus(fn: (s: TermAttachStatus) => void): () => void;
  /** Diagnostic display for debug mode. */
  debugSnapshot(): TermDebugSnapshot;
  select(cockpitTerminalId: string): void;
  /** Id of the currently attached term (null if not open; used to match unknown_term). */
  getTermId(): string | null;
  /** Re-attaches the pty on term.reconnect (e.g. after a restore). */
  reconnect(): void;
  /** Releases the terminal while there are 0 cockpit terminals to stop respawn. */
  suspend(): void;
  /** Re-attaches the terminal when cockpit terminals revive. */
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
}: AppProps) {
  const { t } = useTranslation();
  const terminalFont = useTerminalFontSize();
  const terminalRenderer = useXtermRenderer();
  const clipboardEdit = useClipboardEditEnabled();
  const [addOrgOpen, setAddOrgOpen] = useState(false);
  const [accountUsage, setAccountUsage] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [footerThresholds, setFooterThresholds] = useState<FooterThresholds>(
    DEFAULT_FOOTER_THRESHOLDS,
  );
  const [accountUsageModalOpen, setAccountUsageModalOpen] = useState(false);
  const [hooksStatus, setHooksStatus] = useState<HooksStatusMessage | null>(
    null,
  );
  const { crashLog, dismissCrash } = useCrashReport(crashApi);
  const [notifier] = useState(() => notifierProp ?? createNotifier());
  const [viewStorage] = useState(() =>
    viewStorageProp === undefined ? defaultViewStorage() : viewStorageProp,
  );
  const [conversationTitles, setConversationTitles] = useState(() =>
    loadConversationTitles(viewStorage),
  );
  const [wizardSeen, setWizardSeen] = useState(() =>
    loadFirstRunWizardSeen(viewStorage),
  );
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const toggleSettings = useCallback(() => setSettingsModalOpen((v) => !v), []);

  const { selectedView, activeView, handleViewFocus, handleSelectView } =
    useViewSelection(viewStorage);

  // Interpreting control messages and their side effects (notifications, pty reconnect)
  // is separated into a store outside React; App only subscribes (useSyncExternalStore)
  // and computes derived values.
  const [store] = useState(() =>
    createAppStore({ control, session, notifier }),
  );
  const {
    cockpitTerminals,
    orgs,
    orgColors,
    orgAliases,
    orgNotes,
    notifications,
    account,
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
  // Number of cockpit terminals that have hit the usage limit (input for the footer warning).
  const limitedCount = cockpitTerminals.filter(
    (s) => s.limited === true,
  ).length;
  // Account-wide Claude Code usage for the global footer (null until a session reports limits).
  const accountLimits = pickAccountLimits(cockpitTerminals);
  const usageWarning = useUsageLimitWarning({
    limit: accountLimits?.fiveHour,
    band: footerThresholds.usagePercent.crit,
    notifier,
    buildNotification: (limit) => ({
      title: t("usageWarning.title"),
      body: t("usageWarning.notify", {
        percent: usageRemainingPercent(limit.usedPercent),
        time: fmtResetClock(limit.resetsAt ?? Date.now(), { now: Date.now() }),
      }),
    }),
  });

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
    activeDiffKey,
    activateTabByKey,
    closeTab,
    reorderTabByKey,
    openViewerTab,
    openDiffTab,
  } = useAppTabs(store, cockpitTerminals, selectedCockpitTerminalId);

  // Footer inputs for the active session tab (undefined for viewer/empty; usage null before a transcript).
  const activeSession =
    activeSess !== null
      ? cockpitTerminals.find((s) => s.cockpitTerminalId === activeSess)
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

  const {
    buffers: diffBuffers,
    ensureDiff,
    closeDiff,
    toggleLayout: toggleDiffLayout,
  } = useDiff(gitApi, activeDiffKey);
  const activeDiffBuffer =
    activeDiffKey !== null ? (diffBuffers[activeDiffKey] ?? null) : null;

  // Open a file as a viewer tab (from explorer/search). ensureBuffer fires a read if not yet loaded.
  // Bumping the nonce moves focus to the viewer so it becomes the active view (un-dims it).
  const [viewerFocusNonce, setViewerFocusNonce] = useState(0);
  const openViewer = useCallback(
    (repoPath: string, relPath: string): void => {
      openViewerTab(ensureBuffer(repoPath, relPath));
      setViewerFocusNonce((n) => n + 1);
    },
    [openViewerTab, ensureBuffer],
  );

  // Open a file's diff as a diff tab (from the double-click on a Source Control file row).
  const [diffFocusNonce, setDiffFocusNonce] = useState(0);
  const openDiff = useCallback(
    (
      repoPath: string,
      relPath: string,
      staged: boolean,
      untracked: boolean,
    ): void => {
      openDiffTab(ensureDiff(repoPath, relPath, diffSide(staged, untracked)));
      setDiffFocusNonce((n) => n + 1);
    },
    [openDiffTab, ensureDiff],
  );
  // Tab close removes both the tab and its viewer/diff buffer immediately (read-only, no prompt).
  const closeTabByKey = useCallback(
    (key: string): void => {
      closeTab(key);
      closeViewerBuffer(key);
      closeDiff(key);
    },
    [closeTab, closeViewerBuffer, closeDiff],
  );
  const closeAllTabs = useCallback((): void => {
    for (const tab of tabsState.tabs) closeTabByKey(tabKey(tab));
  }, [tabsState.tabs, closeTabByKey]);

  const { copyToast, flashCopyToast } = useCopyToast();
  const selfUpdate = useSelfUpdate(control, flashCopyToast, t);
  const { copySessionIdByCockpitTerminalId } = useClipboardCopy(
    cockpitTerminals,
    flashCopyToast,
  );

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

  // Copy the absolute path of the file open in the diff (the copy button at the left of the header).
  const copyDiffPath = useCallback(
    (repoPath: string, relPath: string): void => {
      void navigator.clipboard?.writeText(`${repoPath}/${relPath}`).then(
        () => flashCopyToast(t("toast.pathCopied")),
        () => undefined,
      );
    },
    [flashCopyToast, t],
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

  // Launch a new independent cockpit terminal that forks the source session. No-op for sessions without a
  // sid (claude not started); the caller disables the menu.
  const duplicateSession = useCallback(
    (cockpitTerminalId: string): void => {
      const source = cockpitTerminals.find(
        (s) => s.cockpitTerminalId === cockpitTerminalId,
      );
      const sid = source == null ? null : claudeSessionId(source);
      if (source == null || sid === null) return;
      store.markNewRequested();
      control.send({
        t: "cockpitTerminal.new",
        org: source.org,
        resumeSid: sid,
      });
    },
    [cockpitTerminals, store, control],
  );

  useAppKeyboardShortcuts({
    cockpitTerminals,
    orgs,
    activeSess,
    activeKey: tabsState.activeKey,
    handleSelectView,
    toggleSettings,
    newSession,
    duplicateSession,
    closeTabByKey,
  });

  // When all cockpit terminals are removed, release the terminal and stop work regeneration via
  // reconnect. Suspend only on the transition to 0 after having had at least one session
  // (preserves the bootstrap at first startup). Re-attach with resume when they revive.
  const hadSessionsRef = useRef(false);
  useEffect(() => {
    if (cockpitTerminals.length > 0) {
      hadSessionsRef.current = true;
      session.resume();
    } else if (hadSessionsRef.current) {
      session.suspend();
    }
  }, [cockpitTerminals.length, session]);

  // Apply settings pushed by the server's config.json (watch -> config.sync).
  useEffect(() => {
    return control.onMessage((m) => {
      if (m.t !== "config.sync") return;
      notifier.applyServerConfig(m.notifySound);
      setAccountUsage(m.accountUsage);
      setEditor(m.editor);
      setFooterThresholds(m.footerThresholds);
      // Apply the display language if the config file has one (unset = null keeps browser detection).
      if (m.language) void i18n.changeLanguage(m.language);
    });
  }, [control, notifier]);

  const saveAccountUsage = useCallback(
    (enabled: boolean): void => {
      setAccountUsage(enabled);
      control.send({ t: "config.setAccountUsage", enabled });
    },
    [control],
  );

  const refreshAccount = useCallback(
    (restartSessions: boolean): void => {
      control.send({ t: "account.refresh", restartSessions });
    },
    [control],
  );

  const saveEditor = useCallback(
    (command: string): void => {
      control.send({ t: "config.setEditor", editor: command });
    },
    [control],
  );

  const saveFooterThresholds = useCallback(
    (thresholds: FooterThresholds): void => {
      setFooterThresholds(thresholds);
      control.send({
        t: "config.setFooterThresholds",
        footerThresholds: thresholds,
      });
    },
    [control],
  );

  // Persist an org note over REST; the server broadcasts notes.sync so the store updates on success.
  const saveOrgNote = useCallback(
    (org: string, text: string): void => {
      void reposApi.setNote(org, text);
    },
    [reposApi],
  );

  // Track the Claude Code integration status the server pushes (on connect and after each change).
  useEffect(() => {
    return control.onMessage((m) => {
      if (m.t === "hooks.status") setHooksStatus(m);
    });
  }, [control]);

  const setHooksRegistered = useCallback(
    (register: boolean): void => {
      control.send({ t: register ? "hooks.register" : "hooks.unregister" });
    },
    [control],
  );

  const dismissWizard = useCallback((): void => {
    setWizardSeen(true);
    saveFirstRunWizardSeen(viewStorage);
  }, [viewStorage]);

  const enableFromWizard = useCallback((): void => {
    setHooksRegistered(true);
    dismissWizard();
  }, [setHooksRegistered, dismissWizard]);

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
      <div className="app-header">
        <AccountIndicator
          email={account.email}
          runningCount={cockpitTerminals.length}
          onRefresh={refreshAccount}
        />
      </div>
      <UpdateBanner
        version={updateVersion}
        updating={selfUpdate.updating}
        onUpdate={selfUpdate.perform}
      />
      <div className="main-row" onFocusCapture={handleViewFocus}>
        <div
          className={`main-area${activeView === "main" ? "" : " view-inactive"}`}
          data-view="main"
        >
          <TabBar
            tabs={tabsState.tabs}
            activeKey={tabsState.activeKey}
            cockpitTerminals={cockpitTerminals}
            conversationTitles={conversationTitles}
            orgColors={orgColors}
            orgAliases={orgAliases}
            onActivate={activateTabByKey}
            onClose={closeTabByKey}
            onCloseAll={closeAllTabs}
            onRename={handleCommitConversationTitle}
            onReorder={reorderTabByKey}
            inactive={activeView !== "main"}
            onDuplicate={duplicateSession}
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
                renderer={terminalRenderer.renderer}
                clipboardEditEnabled={clipboardEdit.enabled}
                onSetClipboardEditEnabled={clipboardEdit.setEnabled}
              />
            </ErrorBoundary>
            {controlStatus === "open" &&
              cockpitTerminals.length === 0 &&
              activeViewerKey === null &&
              activeDiffKey === null && <EmptyMainArea />}
            {controlStatus === "open" &&
              cockpitTerminals.length > 0 &&
              activeSess === null &&
              activeViewerKey === null &&
              activeDiffKey === null && <NoTabOpen />}
            {activeBuffer !== null && activeViewerKey !== null && (
              <Viewer
                key={activeViewerKey}
                buffer={activeBuffer}
                onTogglePreview={() => toggleViewerPreview(activeViewerKey)}
                onCopyPath={() => copyViewerPath(activeViewerKey)}
                inactive={activeView !== "main"}
                focusNonce={viewerFocusNonce}
              />
            )}
            {activeDiffBuffer !== null && activeDiffKey !== null && (
              <DiffView
                key={activeDiffKey}
                buffer={activeDiffBuffer}
                onToggleLayout={() => toggleDiffLayout(activeDiffKey)}
                onCopyPath={() =>
                  copyDiffPath(
                    activeDiffBuffer.repoPath,
                    activeDiffBuffer.relPath,
                  )
                }
                onOpenInEditor={() =>
                  void gitApi
                    .open(activeDiffBuffer.repoPath, activeDiffBuffer.relPath)
                    .catch(() => undefined)
                }
                inactive={activeView !== "main"}
                focusNonce={diffFocusNonce}
              />
            )}
          </div>
          {activeSess !== null && (
            <SessionStatusFooter
              usage={activeSessionUsage}
              accentColor={activeSessionAccent}
              thresholds={footerThresholds}
            />
          )}
        </div>
        <aside className="side-column">
          <CockpitTerminalListView
            cockpitTerminals={cockpitTerminals}
            orgs={orgs}
            orgColors={orgColors}
            orgAliases={orgAliases}
            conversationTitles={conversationTitles}
            connected={controlStatus === "open"}
            selectedCockpitTerminalId={activeSess}
            onSelect={store.selectCockpitTerminal}
            onFocusTerminal={store.focusTerminal}
            onNew={newSession}
            onClose={(cockpitTerminalId) =>
              control.send({ t: "cockpitTerminal.close", cockpitTerminalId })
            }
            onAddOrg={() => setAddOrgOpen(true)}
            inactive={activeView !== "sessions"}
            full={selectedView === null}
            onDuplicate={duplicateSession}
            onCopySessionId={copySessionIdByCockpitTerminalId}
            onRename={handleCommitConversationTitle}
          />
          {selectedView === "explorer" && (
            <ExplorerView
              api={fsApi}
              orgColors={orgColors}
              orgAliases={orgAliases}
              onOpenFile={openViewer}
              inactive={activeView !== "explorer"}
            />
          )}
          {selectedView === "search" && (
            <SearchView
              api={searchApi}
              orgColors={orgColors}
              orgAliases={orgAliases}
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
              orgAliases={orgAliases}
              onOpenDiff={openDiff}
              inactive={activeView !== "sourceControl"}
            />
          )}
          {selectedView === "notification" && (
            <NotificationView
              notifications={notifications}
              seenIds={seenIds}
              onMarkRead={markRead}
              onDelete={(ids) => {
                for (const id of ids)
                  control.send({ t: "notification.dismiss", id });
                flashCopyToast(
                  t("toast.notificationsDeleted", { count: ids.length }),
                );
              }}
              inactive={activeView !== "notification"}
            />
          )}
          {selectedView === "help" && (
            <HelpView inactive={activeView !== "help"} />
          )}
        </aside>
      </div>
      {settingsModalOpen && (
        <SettingsModal
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
          orgs={orgs}
          orgNotes={orgNotes}
          orgAliases={orgAliases}
          onSaveNote={saveOrgNote}
          onCheckForUpdates={checkForUpdates}
          clipboardEditModal={clipboardEdit.enabled}
          onSetClipboardEditModal={clipboardEdit.setEnabled}
          accountUsage={accountUsage}
          onSetAccountUsage={saveAccountUsage}
          editor={editor ?? ""}
          onSaveEditor={saveEditor}
          footerThresholds={footerThresholds}
          onSaveFooterThresholds={saveFooterThresholds}
          hooksStatus={hooksStatus ?? undefined}
          onSetHooksRegistered={setHooksRegistered}
          renderer={terminalRenderer.renderer}
          onSetRenderer={terminalRenderer.setRenderer}
          onOpenDevtools={canOpenDevtools() ? openDevtools : undefined}
          onOpenDebugPanel={() => setDebugPanelOpen(true)}
          onClose={() => setSettingsModalOpen(false)}
        />
      )}
      {addOrgOpen && (
        <AddOrgModal
          api={reposApi}
          onClose={() => setAddOrgOpen(false)}
          onAdded={(org) => flashCopyToast(t("addOrg.added", { org }))}
        />
      )}
      {accountUsageModalOpen && (
        <AccountUsageModal
          enabled={accountUsage}
          runningCount={cockpitTerminals.filter((s) => s.sid).length}
          onEnable={() => saveAccountUsage(true)}
          onClose={() => setAccountUsageModalOpen(false)}
        />
      )}
      {usageWarning.open && accountLimits?.fiveHour?.resetsAt !== undefined && (
        <UsageLimitWarningDialog
          remainingPercent={usageRemainingPercent(
            accountLimits.fiveHour.usedPercent,
          )}
          unlockTime={fmtResetClock(accountLimits.fiveHour.resetsAt, {
            now: Date.now(),
          })}
          onClose={usageWarning.dismiss}
        />
      )}
      {shouldShowFirstRunWizard(wizardSeen, hooksStatus) && (
        <FirstRunSetupWizard
          statusLineConflict={hooksStatus?.statusLineConflict ?? false}
          onEnable={enableFromWizard}
          onDismiss={dismissWizard}
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
      {debugPanelOpen && (
        <DebugView
          control={control}
          session={session}
          cockpitTerminals={cockpitTerminals}
          onClose={() => setDebugPanelOpen(false)}
        />
      )}
      <footer className="status-bar">
        <AccountUsageFooter
          limits={accountLimits}
          enabled={accountUsage}
          onRequestEnable={() => setAccountUsageModalOpen(true)}
          thresholds={footerThresholds.usagePercent}
        />
        {abnormal !== null && <span className="status-error">{abnormal}</span>}
        <LimitIndicator count={limitedCount} />
        <FooterViewTabs
          selected={selectedView}
          onSelect={handleSelectView}
          badges={{ notification: unread }}
        />
        <FooterSettingsButton onOpen={() => setSettingsModalOpen(true)} />
      </footer>
      {lastError !== null && (
        <ErrorDialog message={lastError} onDismiss={handleDismissError} />
      )}
    </div>
  );
}
