// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  ClientMessage,
  ServerMessage,
  SessionInfo,
} from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { FilesApi } from "./api/files.js";
import type { FsApi } from "./api/fs.js";
import type { GitApi } from "./api/git.js";
import type { ReposApi } from "./api/repos.js";
import type { SearchApi } from "./api/search.js";
import type { ControlDebugSnapshot } from "./debug/debug-model.js";
import i18n from "./i18n/index.js";
import type {
  Notifier,
  NotifyOptions,
  NotifyPermission,
} from "./lib/notify.js";
import type { ControlStatus } from "./ws/control.js";

// To guard the focusNonce / clearNonce wiring (store -> App -> TerminalView.props)
// at the App level, the mock mirrors the received nonces into data attributes.
vi.mock("./ui/TerminalView.js", () => ({
  TerminalView: ({
    focusNonce,
    clearNonce,
  }: {
    focusNonce?: number;
    clearNonce?: number;
  }) => (
    <div
      data-testid="terminal-view"
      data-focus-nonce={focusNonce ?? 0}
      data-clear-nonce={clearNonce ?? 0}
    />
  ),
}));

function terminalFocusNonce(): number {
  return Number(
    screen.getByTestId("terminal-view").getAttribute("data-focus-nonce"),
  );
}

function terminalClearNonce(): number {
  return Number(
    screen.getByTestId("terminal-view").getAttribute("data-clear-nonce"),
  );
}

function createFakeAppControl() {
  const sent: ClientMessage[] = [];
  const messageListeners = new Set<(m: ServerMessage) => void>();
  const statusListeners = new Set<(s: ControlStatus) => void>();
  return {
    sent,
    getStatus: (): ControlStatus => "open",
    send(msg: ClientMessage): boolean {
      sent.push(msg);
      return true;
    },
    onMessage(fn: (m: ServerMessage) => void): () => void {
      messageListeners.add(fn);
      return () => messageListeners.delete(fn);
    },
    onStatus(fn: (s: ControlStatus) => void): () => void {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    debugSnapshot: (): ControlDebugSnapshot => ({
      status: "open",
      attempt: 0,
      lastCloseCode: null,
    }),
    onProtocol: () => () => undefined,
    emit(msg: ServerMessage): void {
      for (const fn of messageListeners) fn(msg);
    },
  };
}

const fakeGitApi: GitApi = {
  status: () => Promise.resolve({ repos: [] }),
  stage: () => Promise.resolve(),
  unstage: () => Promise.resolve(),
  stageAll: () => Promise.resolve(),
  unstageAll: () => Promise.resolve(),
  open: () => Promise.resolve(),
  commit: () => Promise.resolve(),
};

const fakeFsApi: FsApi = {
  repos: () => Promise.resolve({ repos: [] }),
  list: () => Promise.resolve({ entries: [], truncated: false }),
};

const fakeSearchApi: SearchApi = {
  search: () => Promise.resolve({ truncated: false, files: [] }),
};

const fakeFilesApi: FilesApi = {
  read: () => Promise.resolve(""),
};

const fakeReposApi: ReposApi = {
  add: (path) => Promise.resolve({ org: path.split("/").pop() ?? path }),
  validate: (path) =>
    Promise.resolve({ status: "ok", org: path.split("/").pop() ?? path }),
  browse: () => Promise.resolve({ entries: [], truncated: false }),
  list: () => Promise.resolve({ orgs: [] }),
};

function fakeAppSession() {
  const selected: string[] = [];
  const reconnect = vi.fn();
  const suspend = vi.fn();
  const resume = vi.fn();
  return {
    selected,
    reconnect,
    suspend,
    resume,
    session: {
      getStatus: () => "attached" as const,
      onStatus: () => () => undefined,
      debugSnapshot: () => ({
        status: "attached" as const,
        attempt: 0,
        pendingAck: 0,
        windowId: null,
        termId: null,
        suspended: false,
      }),
      onData: () => () => undefined,
      start: () => undefined,
      input: () => undefined,
      resize: () => undefined,
      notifyWritten: () => undefined,
      select: (windowId: string) => void selected.push(windowId),
      getTermId: () => "term-current",
      reconnect,
      suspend,
      resume,
    },
  };
}

function fakeNotifier(permission: NotifyPermission = "granted") {
  const notified: NotifyOptions[] = [];
  let enabled = true;
  const requestPermission = vi.fn(() =>
    Promise.resolve("granted" as NotifyPermission),
  );
  const notifier: Notifier = {
    isEnabled: () => enabled,
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    applyServerConfig: (v: boolean) => {
      enabled = v;
    },
    permission: () => permission,
    requestPermission,
    notify: (opts: NotifyOptions) => void notified.push(opts),
  };
  return { notifier, notified, requestPermission };
}

const sessions: SessionInfo[] = [
  {
    windowId: "@1",
    name: "zashiki",
    org: "kilo",
    repo: "zashiki",
    state: "unknown",
    title: null,
    active: true,
  },
  {
    windowId: "@2",
    name: "tango",
    org: "kilo",
    repo: "tango",
    state: "unknown",
    title: null,
    active: false,
  },
];

const twoOrgSessions: SessionInfo[] = [
  {
    windowId: "@1",
    name: "zashiki",
    org: "kilo",
    repo: "zashiki",
    state: "unknown",
    title: null,
    active: true,
  },
  {
    windowId: "@9",
    name: "app",
    org: "delta",
    repo: "app",
    state: "unknown",
    title: null,
    active: false,
  },
];

afterEach(() => {
  cleanup();
  // Reset the global side effect from the language-switch tests back to ja between tests.
  void i18n.changeLanguage("ja");
});

const ROW_ZASHIKI = /zashiki(?! を閉じる)/;
const ROW_TANGO = /tango(?! を閉じる)/;
const ROW_APP = /app(?! を閉じる)/;

function pressCmdN(): void {
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", metaKey: true }),
    ),
  );
}

function pressCmdW(): void {
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "w", metaKey: true }),
    ),
  );
}

/** Dispatch Cmd+R and return its keydown event (so defaultPrevented can be inspected). */
function pressCmdR(): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key: "r",
    metaKey: true,
    cancelable: true,
  });
  act(() => void window.dispatchEvent(ev));
  return ev;
}

// Tab labels can be identical to session names, so row-button queries are
// scoped to the session list panel.
function inList() {
  return within(screen.getByLabelText("セッション一覧"));
}

function listVisible(): boolean {
  return screen.queryByLabelText("セッション一覧") !== null;
}

describe("App", () => {
  it("suppresses the native right-click menu (except for implemented menus)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    act(() => void document.body.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
  });

  it("the display language switches based on the language in config.sync", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "config.sync",
        notifySound: true,
        debug: false,
        language: "en",
      }),
    );
    expect(i18n.language).toBe("en");
  });

  it("selecting a language in SETTINGS and saving sends config.update and switches the display language", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "設定" }));
    fireEvent.change(screen.getByLabelText("表示言語"), {
      target: { value: "en" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(control.sent).toContainEqual({ t: "config.update", language: "en" });
    expect(i18n.language).toBe("en");
  });

  it("on state.sync, renders sessions grouped by org in the session list panel", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(screen.getByText("kilo (2)")).toBeTruthy();
    expect(inList().getByRole("button", { name: ROW_ZASHIKI })).toBeTruthy();
    expect(inList().getByRole("button", { name: ROW_TANGO })).toBeTruthy();
  });

  it("orgs are shown even with 0 sessions (all orgs from repos.conf)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions: [],
        orgs: ["kilo", "delta"],
        orgColors: {},
      }),
    );
    expect(screen.getByText("delta (0)")).toBeTruthy();
  });

  it("when nothing is selected, the active window of work is highlighted", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({ t: "state.sync", sessions, orgs: [], orgColors: {} }),
    );
    expect(
      inList()
        .getByRole("button", { name: ROW_ZASHIKI })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("double-clicking a window calls session.select and moves the highlight", () => {
    const control = createFakeAppControl();
    const f = fakeAppSession();
    render(
      <App
        control={control}
        session={f.session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({ t: "state.sync", sessions, orgs: [], orgColors: {} }),
    );
    fireEvent.doubleClick(inList().getByRole("button", { name: ROW_TANGO }));
    // On startup the tmux active window (@1) is auto-opened as one tab, so @1 comes
    // first (bootstrap). The double click then selects @2.
    expect(f.selected).toEqual(["@1", "@2"]);
    expect(
      inList()
        .getByRole("button", { name: ROW_TANGO })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("right-clicking an org sends session.new, and right-clicking a row then Delete sends session.close", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    fireEvent.contextMenu(screen.getByText(/kilo \(/));
    fireEvent.click(screen.getByRole("menuitem", { name: "新規セッション" }));
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(control.sent).toEqual([
      { t: "session.new", org: "kilo" },
      { t: "session.close", windowId: "@2" },
    ]);
  });

  it("when creating a new session switches to the new window, focusNonce is passed to TerminalView (store -> App -> TerminalView wiring)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(terminalFocusNonce()).toBe(0);

    fireEvent.contextMenu(screen.getByText(/kilo \(/));
    fireEvent.click(screen.getByRole("menuitem", { name: "新規セッション" }));
    // When a state.sync containing the new window arrives, it auto-selects and bumps focusNonce by 1.
    const newWindow: SessionInfo = {
      windowId: "@42",
      name: "zashiki",
      org: "kilo",
      repo: "zashiki",
      state: "idle",
      title: null,
      active: true,
    };
    act(() =>
      control.emit({
        t: "state.sync",
        sessions: [...sessions, newWindow],
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(terminalFocusNonce()).toBe(1);
  });

  it("switching windows by clicking the list does not advance focusNonce (only on new creation)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions: twoOrgSessions,
        orgs: ["kilo", "delta"],
        orgColors: {},
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: ROW_APP }));
    expect(terminalFocusNonce()).toBe(0);
  });

  it("Cmd+N sends session.new to the org of the highlighted session (works even while the terminal is focused)", () => {
    const control = createFakeAppControl();
    const f = fakeAppSession();
    render(
      <App
        control={control}
        session={f.session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions: twoOrgSessions,
        orgs: ["kilo", "delta"],
        orgColors: {},
      }),
    );
    // Default highlight = the active @1 (kilo).
    pressCmdN();
    expect(control.sent).toContainEqual({
      t: "session.new",
      org: "kilo",
    });
    // Selecting a delta session points Cmd+N at that org (expand via double click).
    fireEvent.doubleClick(screen.getByRole("button", { name: ROW_APP }));
    pressCmdN();
    expect(control.sent).toContainEqual({ t: "session.new", org: "delta" });
  });

  it("when there are 0 orgs, Cmd+N does nothing", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({ t: "state.sync", sessions: [], orgs: [], orgColors: {} }),
    );
    pressCmdN();
    expect(control.sent.some((m) => m.t === "session.new")).toBe(false);
  });

  it("Cmd+W closes the active tab (the tmux session is not killed, only the tab is removed)", () => {
    const control = createFakeAppControl();
    const f = fakeAppSession();
    render(
      <App
        control={control}
        session={f.session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({ t: "state.sync", sessions, orgs: [], orgColors: {} }),
    );
    // bootstrap opens the @1 (zashiki) tab. Double-clicking tango opens @2 and makes it active.
    fireEvent.doubleClick(inList().getByRole("button", { name: ROW_TANGO }));
    expect(screen.getByLabelText("tango のタブを閉じる")).toBeTruthy();

    pressCmdW();

    // The active tango tab closes; the zashiki tab remains.
    expect(screen.queryByLabelText("tango のタブを閉じる")).toBeNull();
    expect(screen.getByLabelText("zashiki のタブを閉じる")).toBeTruthy();
    // The tmux session is not killed (no session.close is sent).
    expect(control.sent.some((m) => m.t === "session.close")).toBe(false);
  });

  it("when there are no tabs, Cmd+W does nothing", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({ t: "state.sync", sessions: [], orgs: [], orgColors: {} }),
    );
    expect(() => pressCmdW()).not.toThrow();
    expect(control.sent.some((m) => m.t === "session.close")).toBe(false);
  });

  it("Cmd+R copies the resume command of the active session", async () => {
    const control = createFakeAppControl();
    const f = fakeAppSession();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      render(
        <App
          control={control}
          session={f.session}
          gitApi={fakeGitApi}
          fsApi={fakeFsApi}
          searchApi={fakeSearchApi}
          filesApi={fakeFilesApi}
          reposApi={fakeReposApi}
        />,
      );
      // bootstrap opens the active @1 (zashiki) tab. Give @1 a sid.
      act(() =>
        control.emit({
          t: "state.sync",
          sessions: [
            { ...sessions[0], sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f" },
            sessions[1],
          ] as SessionInfo[],
          orgs: ["kilo"],
          orgColors: {},
        }),
      );
      const ev = pressCmdR();
      // Reload suppression (preventDefault) takes effect.
      expect(ev.defaultPrevented).toBe(true);
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(
        "claude --resume 0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Cmd+R does not copy for an active session without a sid but still suppresses reload", () => {
    const control = createFakeAppControl();
    const f = fakeAppSession();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      render(
        <App
          control={control}
          session={f.session}
          gitApi={fakeGitApi}
          fsApi={fakeFsApi}
          searchApi={fakeSearchApi}
          filesApi={fakeFilesApi}
          reposApi={fakeReposApi}
        />,
      );
      // @1 has no sid (sessions carry no sid).
      act(() =>
        control.emit({
          t: "state.sync",
          sessions,
          orgs: ["kilo"],
          orgColors: {},
        }),
      );
      const ev = pressCmdR();
      expect(ev.defaultPrevented).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the refresh button sends state.refresh", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "一覧を更新" }));
    expect(control.sent).toEqual([{ t: "state.refresh" }]);
  });

  it("on term.reconnect, reattaches the pty via session.reconnect", () => {
    const control = createFakeAppControl();
    const f = fakeAppSession();
    render(
      <App
        control={control}
        session={f.session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() => control.emit({ t: "term.reconnect", termIds: ["old-term"] }));
    expect(f.reconnect).toHaveBeenCalledTimes(1);
  });

  it("the header reads SESSION LIST and has no manual save/restore buttons (automated)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    expect(screen.getByText("SESSION LIST")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "セッションを保存" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "セッションを復元" }),
    ).toBeNull();
  });

  it("receiving notify calls notifier.notify, and clicking brings to front + focus-jumps", () => {
    const control = createFakeAppControl();
    const f = fakeAppSession();
    const { notifier, notified } = fakeNotifier();
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    render(
      <App
        control={control}
        session={f.session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        notifier={notifier}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions: [
          sessions[0] as SessionInfo,
          { ...(sessions[1] as SessionInfo), title: "PR を作る" },
        ],
        orgs: [],
        orgColors: {},
      }),
    );
    act(() =>
      control.emit({
        t: "notify",
        kind: "waiting",
        windowId: "@2",
        title: "tango",
      }),
    );
    expect(notified).toHaveLength(1);
    expect(notified[0]?.title).toBe("⏳ 応答待ち tango");
    expect(notified[0]?.body).toBe("PR を作る");
    expect(notified[0]?.tag).toBe("zk-@2");
    // Notification click -> bring the tab to front + focus-jump to the matching session.
    act(() => notified[0]?.onClick?.());
    expect(focusSpy).toHaveBeenCalled();
    // Startup bootstrap auto-opens @1 -> the notification click selects @2.
    expect(f.selected).toEqual(["@1", "@2"]);
    expect(
      screen
        .getByRole("button", { name: ROW_TANGO })
        .getAttribute("aria-current"),
    ).toBe("true");
    focusSpy.mockRestore();
  });

  it("a done notify gets a Done title", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const { notifier, notified } = fakeNotifier();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        notifier={notifier}
      />,
    );
    act(() =>
      control.emit({
        t: "notify",
        kind: "done",
        windowId: "@1",
        title: "zashiki",
      }),
    );
    expect(notified[0]?.title).toBe("✅ 完了 zashiki");
    expect(notified[0]?.body).toBeUndefined();
  });

  it("the footer notification-sound and debug toggles are removed (moved to the config file)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const { notifier } = fakeNotifier();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        notifier={notifier}
      />,
    );
    expect(screen.queryByRole("button", { name: /通知音:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /debug:/ })).toBeNull();
  });

  it("config.sync reflects the notification-sound enabled/disabled state into the notifier", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const { notifier } = fakeNotifier();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        notifier={notifier}
      />,
    );
    act(() => {
      control.emit({
        t: "config.sync",
        notifySound: false,
        debug: false,
        language: null,
      });
    });
    expect(notifier.isEnabled()).toBe(false);
    act(() => {
      control.emit({
        t: "config.sync",
        notifySound: true,
        debug: false,
        language: null,
      });
    });
    expect(notifier.isEnabled()).toBe(true);
  });

  it("does not show the notification-permission UI (hidden because it does not work under Tauri)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    // Even with permission=default (before requesting), show no allow button / blocked message.
    const { notifier, requestPermission } = fakeNotifier("default");
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        notifier={notifier}
      />,
    );
    expect(screen.queryByRole("button", { name: "通知を許可" })).toBeNull();
    expect(
      screen.queryByText("通知がブラウザでブロックされています"),
    ).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("server error messages appear in a dialog rather than the footer and dismiss via the close button", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "error",
        code: "internal",
        message: "something failed",
      }),
    );
    const dialog = screen.getByRole("alertdialog", { name: "エラー" });
    expect(within(dialog).getByText(/internal/)).toBeTruthy();
    // Do not surface it in the old footer .status-error.
    expect(document.querySelector(".status-error")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("alertdialog", { name: "エラー" })).toBeNull();
  });

  it("unknown_term does not show a dialog and reattaches the terminal (recovery from server restart)", () => {
    const control = createFakeAppControl();
    const { session, reconnect } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "error",
        code: "unknown_term",
        message: "termId term-current is not open",
      }),
    );
    expect(screen.queryByRole("alertdialog", { name: "エラー" })).toBeNull();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("with 0 sessions the conversation panel shows the empty state, which clears when sessions arrive", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    // Initially (sessions empty, control open) the conversation panel shows the empty state.
    expect(screen.getByText("セッションがありません")).toBeTruthy();
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(screen.queryByText("セッションがありません")).toBeNull();
  });

  it("the session list is always pinned and has no toggle button", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    // Always shown. The footer toggle icons have no session radio.
    expect(inList().getByRole("button", { name: ROW_ZASHIKI })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /セッション一覧/ })).toBeNull();
    // The session list does not disappear when switching to another panel (git).
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    expect(listVisible()).toBe(true);
  });

  it("even if the old key zk.panels.visibility remains, it is not read and the default explorer is shown", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const storage = {
      getItem: (k: string) =>
        k === "zk.panels.visibility"
          ? JSON.stringify({ git: true, explorer: false })
          : null,
      setItem: () => undefined,
    };
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={storage}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    // The old key is not read -> the default explorer is shown and git is not.
    expect(listVisible()).toBe(true);
    expect(
      screen
        .getByRole("radio", { name: "エクスプローラー" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "ソース管理" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("Ctrl+Alt+S does not hide the session list (not a switch target)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(inList().getByRole("button", { name: ROW_ZASHIKI })).toBeTruthy();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true, altKey: true }),
      );
    });
    expect(listVisible()).toBe(true);
  });

  it("the focused panel becomes active and dims the other panels", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const { container } = render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    const conversation = container.querySelector('[data-panel="conversation"]');
    const sessionList = container.querySelector('[data-panel="sessions"]');
    // Initially the conversation panel is active (the session list is dimmed).
    expect(conversation?.classList.contains("panel-inactive")).toBe(false);
    expect(sessionList?.classList.contains("panel-inactive")).toBe(true);
    // When the session list gains focus, active moves to it and the conversation panel dims.
    act(() => (sessionList as HTMLElement).focus());
    expect(sessionList?.classList.contains("panel-inactive")).toBe(false);
    expect(conversation?.classList.contains("panel-inactive")).toBe(true);
  });

  it("single selection: only one selected panel is shown, and the session list stays permanently pinned", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    // Default is explorer. The footer toggle group (role=radiogroup) switches by single selection.
    const { container } = render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    // The side-column holds the session list and always remains.
    expect(container.querySelector(".side-column")).not.toBeNull();
    expect(listVisible()).toBe(true);
    // The footer panel toggle group exists.
    expect(screen.getByRole("radiogroup", { name: "パネル切替" })).toBeTruthy();
    // The default explorer is shown and git is hidden (single selection).
    expect(screen.getByText("EXPLORER")).toBeTruthy();
    expect(screen.queryByText("SOURCE CONTROL")).toBeNull();
    // Switching to git hides explorer and shows git (it switches rather than splitting).
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    expect(screen.queryByText("EXPLORER")).toBeNull();
    expect(screen.getByText("SOURCE CONTROL")).toBeTruthy();
    // The session list remains after switching.
    expect(listVisible()).toBe(true);
  });

  it("re-clicking the active icon closes the panel and the SESSION LIST becomes full height", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const { container } = render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    const sessionList = () => container.querySelector(".session-list");
    // The default explorer is open and SESSION LIST is not full height.
    expect(screen.getByText("EXPLORER")).toBeTruthy();
    expect(sessionList()?.classList.contains("session-list-full")).toBe(false);
    // Re-click the active explorer icon -> the panel closes and all icons become inactive.
    fireEvent.click(screen.getByRole("radio", { name: "エクスプローラー" }));
    expect(screen.queryByText("EXPLORER")).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "エクスプローラー" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    // SESSION LIST becomes full height and stays permanently pinned.
    expect(sessionList()?.classList.contains("session-list-full")).toBe(true);
    expect(listVisible()).toBe(true);
    // Re-clicking reopens it and full height is cleared.
    fireEvent.click(screen.getByRole("radio", { name: "エクスプローラー" }));
    expect(screen.getByText("EXPLORER")).toBeTruthy();
    expect(sessionList()?.classList.contains("session-list-full")).toBe(false);
  });

  it("pressing Ctrl+Alt+E again closes the panel (the keyboard also toggles)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    expect(screen.getByText("EXPLORER")).toBeTruthy();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", ctrlKey: true, altKey: true }),
      ),
    );
    expect(screen.queryByText("EXPLORER")).toBeNull();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", ctrlKey: true, altKey: true }),
      ),
    );
    expect(screen.getByText("EXPLORER")).toBeTruthy();
  });

  it("pressing a different icon from the closed state opens that panel and clears full height", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const { container } = render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    const sessionList = () => container.querySelector(".session-list");
    // Close explorer (full height).
    fireEvent.click(screen.getByRole("radio", { name: "エクスプローラー" }));
    expect(sessionList()?.classList.contains("session-list-full")).toBe(true);
    // Open git from the closed state -> git is shown, full height is cleared, explorer does not appear.
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    expect(screen.getByText("SOURCE CONTROL")).toBeTruthy();
    expect(screen.queryByText("EXPLORER")).toBeNull();
    expect(sessionList()?.classList.contains("session-list-full")).toBe(false);
  });

  it("the SESSION LIST is rendered at the top of the side-column (before the selected panel)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const { container } = render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    const sideColumn = container.querySelector(".side-column");
    if (sideColumn === null) throw new Error("side-column が無い");
    const sessionList = sideColumn.querySelector(".session-list");
    if (sessionList === null) throw new Error("session-list が無い");
    // SESSION LIST is the first element of the side-column (before the selected panel).
    expect(sideColumn.firstElementChild).toBe(sessionList);
  });

  it("Ctrl+Alt+G switches to git and Ctrl+Alt+E switches to explorer (keyboard happy path)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    // Default explorer
    expect(screen.getByText("EXPLORER")).toBeTruthy();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "g", ctrlKey: true, altKey: true }),
      ),
    );
    expect(screen.queryByText("EXPLORER")).toBeNull();
    expect(screen.getByText("SOURCE CONTROL")).toBeTruthy();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", ctrlKey: true, altKey: true }),
      ),
    );
    expect(screen.getByText("EXPLORER")).toBeTruthy();
    expect(screen.queryByText("SOURCE CONTROL")).toBeNull();
  });

  it("after a footer switch, the sole visible panel does not dim", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const { container } = render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    // Move focus to the session list so activePanel is something other than explorer.
    const sessionList = container.querySelector('[data-panel="sessions"]');
    act(() => (sessionList as HTMLElement).focus());
    // Switching to git makes activePanel follow to git at the same time, so it does not dim.
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    const gitPanel = container.querySelector('[data-panel="git"]');
    expect(gitPanel).not.toBeNull();
    expect(gitPanel?.classList.contains("panel-inactive")).toBe(false);
  });

  it("selecting help with Ctrl+Alt+H displays the HelpPanel", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    expect(screen.queryByText("HELP")).toBeNull();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", ctrlKey: true, altKey: true }),
      ),
    );
    expect(screen.getByText("HELP")).toBeTruthy();
  });

  it("does not surface the raw control:/term: enums in the normal footer", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    expect(screen.queryByText("control: open")).toBeNull();
    expect(screen.queryByText("term: attached")).toBeNull();
  });

  it("when control is reconnecting (attempt>0), shows the minimal abnormal notice", () => {
    const control = createFakeAppControl();
    // The abnormal notice uses the subscribed getStatus as the re-render trigger and fills attempt from the snapshot.
    control.getStatus = () => "closed";
    control.debugSnapshot = (): ControlDebugSnapshot => ({
      status: "closed",
      attempt: 2,
      lastCloseCode: 1006,
    });
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    expect(screen.getByText(/接続に問題があります/)).toBeTruthy();
  });

  it("config.sync can open and close the debug panel (moved to the config file)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    expect(screen.queryByRole("region", { name: "デバッグ情報" })).toBeNull();
    act(() => {
      control.emit({
        t: "config.sync",
        notifySound: true,
        debug: true,
        language: null,
      });
    });
    expect(screen.getByRole("region", { name: "デバッグ情報" })).toBeTruthy();
    act(() => {
      control.emit({
        t: "config.sync",
        notifySound: true,
        debug: false,
        language: null,
      });
    });
    expect(screen.queryByRole("region", { name: "デバッグ情報" })).toBeNull();
  });

  it("Ctrl+Alt+D remains as a temporary override for the debug panel", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    expect(screen.queryByRole("region", { name: "デバッグ情報" })).toBeNull();
    act(() => {
      const ev = new KeyboardEvent("keydown", {
        key: "d",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
      });
      window.dispatchEvent(ev);
    });
    expect(screen.getByRole("region", { name: "デバッグ情報" })).toBeTruthy();
  });

  it("with debugInitial=true the debug panel is shown from the start", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        debugInitial
      />,
    );
    expect(screen.getByRole("region", { name: "デバッグ情報" })).toBeTruthy();
  });

  it("Ctrl+Alt+D toggles debug mode (does not collide with E/F/G/S)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        panelStorage={null}
      />,
    );
    expect(screen.queryByRole("region", { name: "デバッグ情報" })).toBeNull();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", ctrlKey: true, altKey: true }),
      );
    });
    expect(screen.getByRole("region", { name: "デバッグ情報" })).toBeTruthy();
    // The default panel (session list) has not disappeared = it does not collide with the panel toggle.
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(inList().getByRole("button", { name: ROW_ZASHIKI })).toBeTruthy();
  });

  it("suspends the terminal when all sessions are deleted and resumes it on revival (suppresses respawn)", () => {
    const control = createFakeAppControl();
    const f = fakeAppSession();
    render(
      <App
        control={control}
        session={f.session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    // Has sessions -> not suspended.
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(f.suspend).not.toHaveBeenCalled();
    // All removed -> suspend (stops work regeneration via reconnect).
    act(() =>
      control.emit({
        t: "state.sync",
        sessions: [],
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(f.suspend).toHaveBeenCalledTimes(1);
    // Revived -> resume.
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    expect(f.resume).toHaveBeenCalled();
  });

  it("clearNonce does not increase after a restart (Bootstrap)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    // Initially 0.
    expect(terminalClearNonce()).toBe(0);
    // state.sync -> Bootstrap calls selectWindow(active) (null -> @1).
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    // The first selection from null does not bump clearNonce.
    expect(terminalClearNonce()).toBe(0);
  });

  it("clearNonce does not increase when closing a tab and reopening the same session", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    // Bootstrap opens the @1 tab. clearNonce = 0.
    expect(terminalClearNonce()).toBe(0);

    // Close the @1 tab (deselect -> selectedWindowId = null).
    pressCmdW();
    expect(terminalClearNonce()).toBe(0);

    // Double-click @1 to reopen it (null -> reselect @1).
    fireEvent.doubleClick(inList().getByRole("button", { name: ROW_ZASHIKI }));
    // A reselection from null, so clearNonce does not bump.
    expect(terminalClearNonce()).toBe(0);
  });

  it("switching sessions increases clearNonce (regression guard)", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        sessions,
        orgs: ["kilo"],
        orgColors: {},
      }),
    );
    // Bootstrap: null → @1、clearNonce = 0。
    expect(terminalClearNonce()).toBe(0);

    // Switch to @2 (@1 -> @2) -> clearNonce +1.
    fireEvent.doubleClick(inList().getByRole("button", { name: ROW_TANGO }));
    expect(terminalClearNonce()).toBe(1);
  });
});
