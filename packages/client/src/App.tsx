import {
  activityIdsForCockpitTerminal,
  type ClientMessage,
  claudeSessionId,
  DEFAULT_FOOTER_THRESHOLDS,
  DEFAULT_NOTIFICATION_SETTINGS,
  type FileEntry,
  type FooterThresholds,
  type HooksStatusMessage,
  isSinglePathSegment,
  type NotificationSettings,
  partitionNotifications,
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
import type { FilesListApi } from "./api/files-list.js";
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
import { loadOnboardingSeen, saveOnboardingSeen } from "./lib/onboarding.js";
import { pickAndReadFile } from "./lib/open-file-dialog.js";
import { canOpenDevtools, openDevtools } from "./lib/tauri-devtools.js";
import { memoDirty } from "./memo/memo-model.js";
import { createMemoSaver } from "./memo/memo-saver.js";
import {
  clampFiveHourWhenLimited,
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
import { HelpModal } from "./ui/HelpModal.js";
import { LimitIndicator } from "./ui/LimitIndicator.js";
import { EmptyMainArea, NoTabOpen } from "./ui/MainAreaEmptyState.js";
import { MemoEditor } from "./ui/MemoEditor.js";
import { NavigationBar } from "./ui/NavigationBar.js";
import { NotificationView } from "./ui/NotificationView.js";
import { QuickOpen } from "./ui/QuickOpen.js";
import { SearchView } from "./ui/SearchView.js";
import { SessionStatusFooter } from "./ui/SessionStatusFooter.js";
import { SessionToaster } from "./ui/SessionToaster.js";
import { SettingsModal } from "./ui/SettingsModal.js";
import { SourceControlView } from "./ui/SourceControlView.js";
import { TabBar } from "./ui/TabBar.js";
import { TerminalView, type TerminalViewSession } from "./ui/TerminalView.js";
import { Toaster } from "./ui/Toaster.js";
import { UpdateBanner } from "./ui/UpdateBanner.js";
import { UsageLimitWarningDialog } from "./ui/UsageLimitWarningDialog.js";
import { useAppKeyboardShortcuts } from "./ui/useAppKeyboardShortcuts.js";
import { useAppTabs } from "./ui/useAppTabs.js";
import { useBeforeUnloadGuard } from "./ui/useBeforeUnloadGuard.js";
import { useClipboardCopy } from "./ui/useClipboardCopy.js";
import { useClipboardEditEnabled } from "./ui/useClipboardEditEnabled.js";
import { useCopyToast } from "./ui/useCopyToast.js";
import { useCrashReport } from "./ui/useCrashReport.js";
import { useDiff } from "./ui/useDiff.js";
import { useFileDrop } from "./ui/useFileDrop.js";
import { useGitStatus } from "./ui/useGitStatus.js";
import { useQuitGuard } from "./ui/useQuitGuard.js";
import { useSeenNotifications } from "./ui/useSeenNotifications.js";
import { useSelfUpdate } from "./ui/useSelfUpdate.js";
import { useTerminalFontSize } from "./ui/useTerminalFontSize.js";
import { useUsageLimitWarning } from "./ui/useUsageLimitWarning.js";
import { useViewer } from "./ui/useViewer.js";
import { useViewSelection } from "./ui/useViewSelection.js";
import { useXtermRenderer } from "./ui/useXtermRenderer.js";
import { Viewer } from "./ui/Viewer.js";
import { WelcomeOnboardingModal } from "./ui/WelcomeOnboardingModal.js";
import { type MediaKind, mediaKind } from "./viewer/media.js";
import {
  viewerKeysUnderPath,
  viewersAffectedByRename,
} from "./viewer/viewer-model.js";
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
  /** The quick-open (Cmd+P) file-listing REST. */
  filesListApi: FilesListApi;
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
  filesListApi,
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
  const [memoEnabled, setMemoEnabled] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [footerThresholds, setFooterThresholds] = useState<FooterThresholds>(
    DEFAULT_FOOTER_THRESHOLDS,
  );
  const [notificationSettings, setNotificationSettings] =
    useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
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
  // Gate the first-run flow on persistable storage: a returning/updated user (seen flag present) or
  // a storage-less session starts at "done", so the welcome only ever greets a fresh install.
  const [onboardingStep, setOnboardingStep] = useState<
    "welcome" | "integration" | "done"
  >(() =>
    viewStorage !== null && !loadOnboardingSeen(viewStorage)
      ? "welcome"
      : "done",
  );
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  // Help and Settings are peer chrome modals; opening one closes the other so they never stack.
  const toggleSettings = useCallback(() => {
    setHelpModalOpen(false);
    setSettingsModalOpen((v) => !v);
  }, []);
  const toggleHelp = useCallback(() => {
    setSettingsModalOpen(false);
    setHelpModalOpen((v) => !v);
  }, []);

  const { selectedView, handleSelectView } = useViewSelection(viewStorage);

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
    memo,
    notifications,
    sessionToasts,
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
  const { activity: activityNotifications, system: systemNotifications } =
    partitionNotifications(notifications);
  const activityUnread = unreadCount(activityNotifications, seenIds);
  const systemUnread = unreadCount(systemNotifications, seenIds);
  // Auto-read: an activity entry is read once its target Cockpit Terminal is active. Selecting a
  // terminal by any means (toast, tab, keyboard, external select) funnels through
  // selectedCockpitTerminalId, so watching it covers "reached via toast" and "activated otherwise".
  useEffect(() => {
    if (selectedCockpitTerminalId === null) return;
    const ids = activityIdsForCockpitTerminal(
      notifications,
      selectedCockpitTerminalId,
    );
    if (ids.length > 0) markRead(ids);
  }, [selectedCockpitTerminalId, notifications, markRead]);
  const updateVersion = updateAvailableVersion(notifications);
  // Number of cockpit terminals that have hit the usage limit (input for the footer warning).
  const limitedCount = cockpitTerminals.filter(
    (s) => s.limited === true,
  ).length;
  // Account-wide Claude Code usage (null until a session reports limits), corrected by the
  // on-screen limit signal so the footer and the warning dialog read the same number.
  const accountLimits = clampFiveHourWhenLimited(
    pickAccountLimits(cockpitTerminals),
    limitedCount > 0,
  );
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
    activeMemoKey,
    activateTabByKey,
    closeTab,
    reorderTabByKey,
    openViewerTab,
    openDiffTab,
  } = useAppTabs(
    store,
    cockpitTerminals,
    selectedCockpitTerminalId,
    memoEnabled,
  );

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
    ensureMediaBuffer,
    openExternal: openExternalViewer,
    openExternalMedia,
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

  // Open a file as a viewer tab (from explorer/search/quick-open). ensureBuffer fires a read if not
  // yet loaded. Bumping the nonce moves focus to the viewer so it becomes the active view (un-dims it).
  // A target line (from search/quick-open) is recorded per buffer key so the viewer scrolls to it once
  // the content is ready.
  const [viewerFocusNonce, setViewerFocusNonce] = useState(0);
  const [viewerReveal, setViewerReveal] = useState<{
    key: string;
    line: number;
    nonce: number;
  } | null>(null);
  const clearViewerReveal = useCallback(() => setViewerReveal(null), []);
  const openViewer = useCallback(
    (repoPath: string, relPath: string, line?: number | null): void => {
      const kind = mediaKind(relPath);
      const key =
        kind !== null
          ? ensureMediaBuffer(repoPath, relPath, kind)
          : ensureBuffer(repoPath, relPath);
      openViewerTab(key);
      setViewerFocusNonce((n) => n + 1);
      if (kind === null && typeof line === "number" && line > 0) {
        setViewerReveal((prev) => ({
          key,
          line,
          nonce: (prev?.nonce ?? 0) + 1,
        }));
      }
    },
    [openViewerTab, ensureBuffer, ensureMediaBuffer],
  );

  // Quick-open palette (Cmd+P). The file list is fetched each time it opens and generation-guarded so
  // a slow response can't repopulate a palette the user already closed. The active org ranks first.
  const activeOrg = activeSession?.org ?? orgs[0] ?? null;
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenFiles, setQuickOpenFiles] = useState<{
    files: FileEntry[];
    truncated: boolean;
  }>({ files: [], truncated: false });
  const quickOpenGen = useRef(0);
  const openQuickOpen = useCallback((): void => {
    setQuickOpenVisible(true);
    quickOpenGen.current += 1;
    const gen = quickOpenGen.current;
    void filesListApi.list().then(
      (res) => {
        if (gen === quickOpenGen.current)
          setQuickOpenFiles({ files: res.files, truncated: res.truncated });
      },
      () => {
        if (gen === quickOpenGen.current)
          setQuickOpenFiles({ files: [], truncated: false });
      },
    );
  }, [filesListApi]);
  const closeQuickOpen = useCallback((): void => {
    quickOpenGen.current += 1;
    setQuickOpenVisible(false);
  }, []);

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

  // Focus the Memo editor when its tab becomes active (its own nonce, not the terminal's), mirroring
  // the viewer/diff focus-on-open so clicking onto the Memo tab moves the caret into the editor.
  const [memoFocusNonce, setMemoFocusNonce] = useState(0);
  useEffect(() => {
    if (activeMemoKey !== null) setMemoFocusNonce((n) => n + 1);
  }, [activeMemoKey]);
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
  const [memoSaver] = useState(() =>
    createMemoSaver(
      () => store.getSnapshot().memo,
      (text, signal) => reposApi.setMemo(text, signal),
      (text) => store.markMemoSaved(text),
    ),
  );
  // A failed/timed-out save leaves the buffer dirty (onSaved didn't run); surface it so the user knows
  // to retry rather than assuming it saved.
  const saveMemo = useCallback(
    (text: string): void => {
      void memoSaver
        .save(text)
        .catch(() => flashCopyToast(t("toast.memoSaveFailed")));
    },
    [memoSaver, flashCopyToast, t],
  );
  const selfUpdate = useSelfUpdate(control, flashCopyToast, t, memoSaver.flush);
  useBeforeUnloadGuard(memoEnabled && memoDirty(memo));
  useQuitGuard(
    () => memoEnabled && memoDirty(store.getSnapshot().memo),
    memoSaver.flush,
  );

  // Delete (dismiss) notifications from the read tab; shared by the ACTIVITY and NOTIFICATION views.
  const deleteNotifications = useCallback(
    (ids: readonly string[]): void => {
      for (const id of ids) control.send({ t: "notification.dismiss", id });
      flashCopyToast(t("toast.notificationsDeleted", { count: ids.length }));
    },
    [control, flashCopyToast, t],
  );
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

  // Open a file dropped from Finder in the viewer (content read in the WebView; no repo read).
  const openExternalFile = useCallback(
    (name: string, content: string): void => {
      openViewerTab(openExternalViewer(name, content));
      setViewerFocusNonce((n) => n + 1);
    },
    [openViewerTab, openExternalViewer],
  );
  const openExternalMediaFile = useCallback(
    (name: string, file: File, kind: MediaKind): void => {
      openViewerTab(openExternalMedia(name, file, kind));
      setViewerFocusNonce((n) => n + 1);
    },
    [openViewerTab, openExternalMedia],
  );
  const fileDrop = useFileDrop(
    openExternalFile,
    openExternalMediaFile,
    (name, error) => {
      flashCopyToast(
        t(
          error === "tooLarge"
            ? "viewer.dropTooLarge"
            : "viewer.dropReadFailed",
          { name },
        ),
      );
    },
  );

  // Cmd+O: pick a file via the native dialog and open it read-only in the viewer (external buffer).
  const openFileFromDialog = useCallback((): void => {
    void pickAndReadFile(t("openFile.dialogTitle")).then(
      (picked) => {
        if (picked !== null) openExternalFile(picked.name, picked.content);
      },
      (err: unknown) => {
        // Tauri rejects with a raw string code; the browser fallback throws an Error with the code.
        const reason = err instanceof Error ? err.message : String(err);
        flashCopyToast(
          t(reason === "tooLarge" ? "openFile.tooLarge" : "openFile.failed"),
        );
      },
    );
  }, [t, openExternalFile, flashCopyToast]);

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

  // Copy arbitrary text (context-menu path copies) with the shared "path copied" toast.
  const copyExplorerText = useCallback(
    (text: string): void => {
      void navigator.clipboard?.writeText(text).then(
        () => flashCopyToast(t("toast.pathCopied")),
        () => undefined,
      );
    },
    [flashCopyToast, t],
  );

  const closeViewerTabByBufferKey = useCallback(
    (bufferKey: string): void => {
      closeTabByKey(tabKey({ kind: "viewer", id: bufferKey }));
      closeViewerBuffer(bufferKey);
    },
    [closeTabByKey, closeViewerBuffer],
  );

  const handlePathRenamed = useCallback(
    (repoPath: string, oldRel: string, newRel: string): void => {
      const affected = viewersAffectedByRename(
        viewerBuffers,
        repoPath,
        oldRel,
        newRel,
      );
      if (affected.length === 0) return;
      const previousActiveKey = tabsState.activeKey;
      const activeAffected = affected.find((a) => a.key === activeViewerKey);
      for (const a of affected) closeViewerTabByBufferKey(a.key);
      for (const a of affected) {
        if (a !== activeAffected) openViewer(repoPath, a.newRelPath);
      }
      if (activeAffected !== undefined) {
        openViewer(repoPath, activeAffected.newRelPath);
      } else if (previousActiveKey !== null) {
        activateTabByKey(previousActiveKey);
      }
    },
    [
      viewerBuffers,
      tabsState.activeKey,
      activeViewerKey,
      closeViewerTabByBufferKey,
      openViewer,
      activateTabByKey,
    ],
  );

  const handlePathDeleted = useCallback(
    (repoPath: string, rel: string): void => {
      for (const key of viewerKeysUnderPath(viewerBuffers, repoPath, rel)) {
        closeViewerTabByBufferKey(key);
      }
    },
    [viewerBuffers, closeViewerTabByBufferKey],
  );

  // Rename a file from a viewer tab's context menu, then follow it in the open tabs.
  const renameFileFromTab = useCallback(
    (repoPath: string, relPath: string, newName: string): void => {
      const current = relPath.slice(relPath.lastIndexOf("/") + 1);
      if (
        newName === "" ||
        newName === current ||
        !isSinglePathSegment(newName)
      ) {
        return;
      }
      void fsApi.rename(repoPath, relPath, newName).then(
        (newRel) => handlePathRenamed(repoPath, relPath, newRel),
        (err: unknown) => flashCopyToast(String(err)),
      );
    },
    [fsApi, handlePathRenamed, flashCopyToast],
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

  const onChangeMemo = useCallback(
    (text: string): void => {
      store.setMemoText(text);
    },
    [store],
  );

  useAppKeyboardShortcuts({
    cockpitTerminals,
    orgs,
    activeSess,
    activeKey: tabsState.activeKey,
    handleSelectView,
    toggleHelp,
    toggleSettings,
    newSession,
    duplicateSession,
    closeTabByKey,
    openQuickOpen,
    openFile: openFileFromDialog,
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
      notifier.applyServerConfig(m.notifications);
      setNotificationSettings(m.notifications);
      setAccountUsage(m.accountUsage);
      setMemoEnabled(m.memoEnabled);
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

  const setMemoEnabledPref = useCallback(
    (enabled: boolean): void => {
      setMemoEnabled(enabled);
      control.send({ t: "config.setMemoEnabled", enabled });
    },
    [control],
  );

  const refreshAccount = useCallback(
    (restartSessions: boolean): void => {
      control.send({ t: "account.refresh", restartSessions });
    },
    [control],
  );

  const loginAccount = useCallback((): void => {
    control.send({ t: "account.login" });
  }, [control]);

  const logoutAccount = useCallback((): void => {
    control.send({ t: "account.logout" });
  }, [control]);

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

  const saveNotifications = useCallback(
    (notifications: NotificationSettings): void => {
      setNotificationSettings(notifications);
      control.send({ t: "config.setNotifications", notifications });
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

  // Persist the org display order after a drag reorder; the server reflects it via state.sync.
  const saveOrgOrder = useCallback(
    (nextOrgs: string[]): void => {
      void reposApi.setOrgOrder(nextOrgs);
    },
    [reposApi],
  );

  // Persist an org color / alias over REST; the server reflects it via state.sync (a blank value resets).
  const saveOrgColor = useCallback(
    (org: string, color: string): void => {
      void reposApi.setColor(org, color);
    },
    [reposApi],
  );
  const saveOrgAlias = useCallback(
    (org: string, alias: string): void => {
      void reposApi.setAlias(org, alias);
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

  // Any exit from onboarding (skip, enable, or decline) also settles the integration prompt, so the
  // standalone setup wizard never pops up right after the user leaves the flow.
  const finishOnboarding = useCallback((): void => {
    setOnboardingStep("done");
    saveOnboardingSeen(viewStorage);
    dismissWizard();
  }, [viewStorage, dismissWizard]);

  const integrationRegistered =
    hooksStatus?.hooksRegistered === true &&
    hooksStatus?.statusLineRegistered === true;

  const startFromWelcome = useCallback((): void => {
    if (integrationRegistered) finishOnboarding();
    else setOnboardingStep("integration");
  }, [integrationRegistered, finishOnboarding]);

  const enableFromOnboarding = useCallback((): void => {
    setHooksRegistered(true);
    finishOnboarding();
  }, [setHooksRegistered, finishOnboarding]);

  const reopenOnboarding = useCallback((): void => {
    setSettingsModalOpen(false);
    setOnboardingStep("welcome");
  }, []);

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

  // Owned above the conditionally-mounted SourceControlView so status survives left-view switches.
  const gitStatus = useGitStatus(gitApi, onGitDirty);

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
    // biome-ignore lint/a11y/noStaticElementInteractions: window-wide receiver for OS file drops, not an interactive widget
    <div
      className="app"
      onDragOver={fileDrop.onDragOver}
      onDrop={fileDrop.onDrop}
    >
      <div className="title-bar" data-tauri-drag-region="">
        <AccountIndicator
          email={account.email}
          runningCount={cockpitTerminals.length}
          onRefresh={refreshAccount}
          onLogin={loginAccount}
          onLogout={logoutAccount}
        />
      </div>
      <UpdateBanner
        version={updateVersion}
        updating={selfUpdate.updating}
        onUpdate={selfUpdate.perform}
      />
      <div className="main-row">
        <NavigationBar
          selected={selectedView}
          onSelect={handleSelectView}
          onOpenHelp={() => {
            setSettingsModalOpen(false);
            setHelpModalOpen(true);
          }}
          onOpenSettings={() => {
            setHelpModalOpen(false);
            setSettingsModalOpen(true);
          }}
          badges={{ activity: activityUnread, notification: systemUnread }}
        />
        {selectedView !== null && (
          <aside className="left-area">
            {selectedView === "explorer" && (
              <ExplorerView
                api={fsApi}
                orgColors={orgColors}
                orgAliases={orgAliases}
                onOpenFile={openViewer}
                onCopyText={copyExplorerText}
                onFsError={flashCopyToast}
                onPathRenamed={handlePathRenamed}
                onPathDeleted={handlePathDeleted}
              />
            )}
            {selectedView === "search" && (
              <SearchView
                api={searchApi}
                orgColors={orgColors}
                orgAliases={orgAliases}
                onOpen={(file, line) =>
                  openViewer(repoPathOfSearchFile(file), file.relPath, line)
                }
              />
            )}
            {selectedView === "sourceControl" && (
              <SourceControlView
                api={gitApi}
                gitStatus={gitStatus}
                orgColors={orgColors}
                orgAliases={orgAliases}
                onOpenDiff={openDiff}
              />
            )}
            {selectedView === "activity" && (
              <NotificationView
                title="ACTIVITY"
                dataView="activity"
                notifications={activityNotifications}
                seenIds={seenIds}
                onMarkRead={markRead}
                onDelete={deleteNotifications}
              />
            )}
            {selectedView === "notification" && (
              <NotificationView
                notifications={systemNotifications}
                seenIds={seenIds}
                onMarkRead={markRead}
                onDelete={deleteNotifications}
              />
            )}
          </aside>
        )}
        <div className="main-area" data-view="main">
          <TabBar
            tabs={tabsState.tabs}
            activeKey={tabsState.activeKey}
            cockpitTerminals={cockpitTerminals}
            conversationTitles={conversationTitles}
            memoDirty={memoDirty(memo)}
            orgColors={orgColors}
            orgAliases={orgAliases}
            onActivate={activateTabByKey}
            onClose={closeTabByKey}
            onCloseAll={closeAllTabs}
            onRename={handleCommitConversationTitle}
            onReorder={reorderTabByKey}
            onDuplicate={duplicateSession}
            onCopySessionId={copySessionIdByCockpitTerminalId}
            onRevealFile={(repoPath, relPath) =>
              void fsApi
                .reveal(repoPath, relPath)
                .catch((err: unknown) => flashCopyToast(String(err)))
            }
            onCopyFilePath={(repoPath, relPath) =>
              copyExplorerText(`${repoPath}/${relPath}`)
            }
            onCopyFileRelativePath={(_repoPath, relPath) =>
              copyExplorerText(relPath)
            }
            onRenameFile={renameFileFromTab}
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
              activeDiffKey === null &&
              activeMemoKey === null && <EmptyMainArea />}
            {controlStatus === "open" &&
              cockpitTerminals.length > 0 &&
              activeSess === null &&
              activeViewerKey === null &&
              activeDiffKey === null &&
              activeMemoKey === null && <NoTabOpen />}
            {activeBuffer !== null && activeViewerKey !== null && (
              <Viewer
                key={activeViewerKey}
                buffer={activeBuffer}
                onTogglePreview={() => toggleViewerPreview(activeViewerKey)}
                onCopyPath={() => copyViewerPath(activeViewerKey)}
                focusNonce={viewerFocusNonce}
                revealLine={
                  viewerReveal?.key === activeViewerKey
                    ? viewerReveal.line
                    : undefined
                }
                revealNonce={
                  viewerReveal?.key === activeViewerKey
                    ? viewerReveal.nonce
                    : undefined
                }
                onRevealed={clearViewerReveal}
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
                focusNonce={diffFocusNonce}
              />
            )}
            {activeMemoKey !== null && (
              <MemoEditor
                buffer={memo}
                onChange={onChangeMemo}
                onSave={saveMemo}
                focusNonce={memoFocusNonce}
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
        <aside className="right-column">
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
            onDuplicate={duplicateSession}
            onCopySessionId={copySessionIdByCockpitTerminalId}
            onRename={handleCommitConversationTitle}
            onReorderOrgs={saveOrgOrder}
            onReorderRows={(order) =>
              control.send({ t: "cockpitTerminal.reorder", order })
            }
          />
        </aside>
      </div>
      {quickOpenVisible && (
        <QuickOpen
          files={quickOpenFiles.files}
          truncated={quickOpenFiles.truncated}
          activeOrg={activeOrg}
          orgColors={orgColors}
          orgAliases={orgAliases}
          onOpen={(file, line) => {
            openViewer(repoPathOfSearchFile(file), file.relPath, line);
            closeQuickOpen();
          }}
          onClose={closeQuickOpen}
        />
      )}
      {helpModalOpen && <HelpModal onClose={() => setHelpModalOpen(false)} />}
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
          orgColors={orgColors}
          onSaveNote={saveOrgNote}
          onSaveColor={saveOrgColor}
          onSaveAlias={saveOrgAlias}
          onCheckForUpdates={checkForUpdates}
          clipboardEditModal={clipboardEdit.enabled}
          onSetClipboardEditModal={clipboardEdit.setEnabled}
          accountUsage={accountUsage}
          onSetAccountUsage={saveAccountUsage}
          memoEnabled={memoEnabled}
          onSetMemoEnabled={setMemoEnabledPref}
          editor={editor ?? ""}
          onSaveEditor={saveEditor}
          footerThresholds={footerThresholds}
          onSaveFooterThresholds={saveFooterThresholds}
          notificationSettings={notificationSettings}
          onSetNotifications={saveNotifications}
          hooksStatus={hooksStatus ?? undefined}
          onSetHooksRegistered={setHooksRegistered}
          renderer={terminalRenderer.renderer}
          onSetRenderer={terminalRenderer.setRenderer}
          onOpenDevtools={canOpenDevtools() ? openDevtools : undefined}
          onOpenDebugPanel={() => setDebugPanelOpen(true)}
          onShowOnboarding={reopenOnboarding}
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
      {onboardingStep === "welcome" && (
        <WelcomeOnboardingModal
          onStart={startFromWelcome}
          onSkip={finishOnboarding}
        />
      )}
      {onboardingStep === "integration" && (
        <FirstRunSetupWizard
          statusLineConflict={hooksStatus?.statusLineConflict ?? false}
          onEnable={enableFromOnboarding}
          onDismiss={finishOnboarding}
        />
      )}
      {onboardingStep === "done" &&
        shouldShowFirstRunWizard(wizardSeen, hooksStatus) && (
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
      <SessionToaster
        toasts={sessionToasts}
        onActivate={store.activateSessionToast}
        onDismiss={store.dismissSessionToast}
      />
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
      </footer>
      {lastError !== null && (
        <ErrorDialog message={lastError} onDismiss={handleDismissError} />
      )}
    </div>
  );
}
