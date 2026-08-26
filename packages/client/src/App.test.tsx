// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  type ClientMessage,
  type CockpitTerminalInfo,
  DEFAULT_FOOTER_THRESHOLDS,
  type ServerMessage,
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

// To guard the focusNonce wiring (store -> App -> TerminalView.props) at the App level,
// the mock mirrors the received nonce into a data attribute.
vi.mock("./ui/TerminalView.js", () => ({
  TerminalView: ({ focusNonce }: { focusNonce?: number }) => (
    <div data-testid="terminal-view" data-focus-nonce={focusNonce ?? 0} />
  ),
}));

function terminalFocusNonce(): number {
  return Number(
    screen.getByTestId("terminal-view").getAttribute("data-focus-nonce"),
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
  removeWorktree: () => Promise.resolve(),
  open: () => Promise.resolve(),
  commit: () => Promise.resolve(),
  diff: () =>
    Promise.resolve({
      oldText: "",
      newText: "",
      binary: false,
      tooLarge: false,
      added: 0,
      removed: 0,
    }),
};

const fakeFsApi: FsApi = {
  repos: () => Promise.resolve({ repos: [] }),
  list: () => Promise.resolve({ entries: [], truncated: false }),
  reveal: () => Promise.resolve(),
  rename: (_repoPath, _path, newName) => Promise.resolve(newName),
  delete: () => Promise.resolve(),
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
  setNote: () => Promise.resolve(),
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
        cockpitTerminalId: null,
        termId: null,
        suspended: false,
      }),
      onData: () => () => undefined,
      start: () => undefined,
      input: () => undefined,
      resize: () => undefined,
      notifyWritten: () => undefined,
      select: (cockpitTerminalId: string) =>
        void selected.push(cockpitTerminalId),
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

const cockpitTerminals: CockpitTerminalInfo[] = [
  {
    cockpitTerminalId: "@1",
    name: "zashiki",
    org: "kilo",
    repo: "zashiki",
    state: "unknown",
    title: null,
    active: true,
  },
  {
    cockpitTerminalId: "@2",
    name: "tango",
    org: "kilo",
    repo: "tango",
    state: "unknown",
    title: null,
    active: false,
  },
];

const twoOrgSessions: CockpitTerminalInfo[] = [
  {
    cockpitTerminalId: "@1",
    name: "zashiki",
    org: "kilo",
    repo: "zashiki",
    state: "unknown",
    title: null,
    active: true,
  },
  {
    cockpitTerminalId: "@9",
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
// scoped to the session list view.
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
        updateCheck: true,
        language: "en",
        accountUsage: false,
        editor: null,
        footerThresholds: DEFAULT_FOOTER_THRESHOLDS,
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
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    fireEvent.change(screen.getByLabelText("表示言語"), {
      target: { value: "en" },
    });
    // The editor field has its own "保存" button; the language Save is the first in document order.
    const [languageSave] = screen.getAllByRole("button", { name: "保存" });
    if (!languageSave) throw new Error("language save button missing");
    fireEvent.click(languageSave);
    expect(control.sent).toContainEqual({ t: "config.update", language: "en" });
    expect(i18n.language).toBe("en");
  });

  it("on state.sync, renders cockpitTerminals grouped by org in the session list view", () => {
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
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    expect(screen.getByText("kilo (2)")).toBeTruthy();
    expect(inList().getByRole("button", { name: ROW_ZASHIKI })).toBeTruthy();
    expect(inList().getByRole("button", { name: ROW_TANGO })).toBeTruthy();
  });

  it("orgs are shown even with 0 cockpitTerminals (all orgs from repos.conf)", () => {
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
        cockpitTerminals: [],
        orgs: ["kilo", "delta"],
        orgColors: {},
        orgAliases: {},
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
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: [],
        orgColors: {},
        orgAliases: {},
      }),
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
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: [],
        orgColors: {},
        orgAliases: {},
      }),
    );
    fireEvent.doubleClick(inList().getByRole("button", { name: ROW_TANGO }));
    // On startup the active window (@1) is auto-opened as one tab, so @1 comes
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
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    fireEvent.contextMenu(screen.getByText(/kilo \(/));
    fireEvent.click(screen.getByRole("menuitem", { name: "新規セッション" }));
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(control.sent).toEqual([
      { t: "cockpitTerminal.new", org: "kilo" },
      { t: "cockpitTerminal.close", cockpitTerminalId: "@2" },
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
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    expect(terminalFocusNonce()).toBe(0);

    fireEvent.contextMenu(screen.getByText(/kilo \(/));
    fireEvent.click(screen.getByRole("menuitem", { name: "新規セッション" }));
    // When a state.sync containing the new window arrives, it auto-selects and bumps focusNonce by 1.
    const newWindow: CockpitTerminalInfo = {
      cockpitTerminalId: "@42",
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
        cockpitTerminals: [...cockpitTerminals, newWindow],
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
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
        cockpitTerminals: twoOrgSessions,
        orgs: ["kilo", "delta"],
        orgColors: {},
        orgAliases: {},
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
        cockpitTerminals: twoOrgSessions,
        orgs: ["kilo", "delta"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    // Default highlight = the active @1 (kilo).
    pressCmdN();
    expect(control.sent).toContainEqual({
      t: "cockpitTerminal.new",
      org: "kilo",
    });
    // Selecting a delta session points Cmd+N at that org (expand via double click).
    fireEvent.doubleClick(screen.getByRole("button", { name: ROW_APP }));
    pressCmdN();
    expect(control.sent).toContainEqual({
      t: "cockpitTerminal.new",
      org: "delta",
    });
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
      control.emit({
        t: "state.sync",
        cockpitTerminals: [],
        orgs: [],
        orgColors: {},
        orgAliases: {},
      }),
    );
    pressCmdN();
    expect(control.sent.some((m) => m.t === "cockpitTerminal.new")).toBe(false);
  });

  it("Cmd+W closes the active tab (the session is not killed, only the tab is removed)", () => {
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
        cockpitTerminals,
        orgs: [],
        orgColors: {},
        orgAliases: {},
      }),
    );
    // bootstrap opens the @1 (zashiki) tab. Double-clicking tango opens @2 and makes it active.
    fireEvent.doubleClick(inList().getByRole("button", { name: ROW_TANGO }));
    expect(screen.getByLabelText("tango のタブを閉じる")).toBeTruthy();

    pressCmdW();

    // The active tango tab closes; the zashiki tab remains.
    expect(screen.queryByLabelText("tango のタブを閉じる")).toBeNull();
    expect(screen.getByLabelText("zashiki のタブを閉じる")).toBeTruthy();
    // The session is not killed (no session.close is sent).
    expect(control.sent.some((m) => m.t === "cockpitTerminal.close")).toBe(
      false,
    );
  });

  it("the tab context menu 'Close all' removes every tab without killing the sessions", () => {
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
        cockpitTerminals,
        orgs: [],
        orgColors: {},
        orgAliases: {},
      }),
    );
    // bootstrap opens @1 (zashiki); double-clicking tango opens @2 -> two tabs.
    fireEvent.doubleClick(inList().getByRole("button", { name: ROW_TANGO }));
    expect(screen.getByLabelText("zashiki のタブを閉じる")).toBeTruthy();
    expect(screen.getByLabelText("tango のタブを閉じる")).toBeTruthy();

    fireEvent.contextMenu(screen.getAllByRole("tab")[0] as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "全て閉じる" }));

    // Both tabs are gone (the strip renders nothing once empty).
    expect(screen.queryByLabelText("zashiki のタブを閉じる")).toBeNull();
    expect(screen.queryByLabelText("tango のタブを閉じる")).toBeNull();
    // Closing tabs never kills the sessions.
    expect(control.sent.some((m) => m.t === "cockpitTerminal.close")).toBe(
      false,
    );
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
      control.emit({
        t: "state.sync",
        cockpitTerminals: [],
        orgs: [],
        orgColors: {},
        orgAliases: {},
      }),
    );
    expect(() => pressCmdW()).not.toThrow();
    expect(control.sent.some((m) => m.t === "cockpitTerminal.close")).toBe(
      false,
    );
  });

  it("Cmd+R duplicates the active session into a new forked terminal", () => {
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
    // bootstrap opens the active @1 (zashiki) tab. Give @1 a sid.
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals: [
          {
            ...cockpitTerminals[0],
            sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f",
          },
          cockpitTerminals[1],
        ] as CockpitTerminalInfo[],
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    const ev = pressCmdR();
    // Reload suppression (preventDefault) takes effect.
    expect(ev.defaultPrevented).toBe(true);
    expect(control.sent).toContainEqual({
      t: "cockpitTerminal.new",
      org: "kilo",
      resumeSid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f",
    });
  });

  it("Cmd+R does not duplicate for an active session without a sid but still suppresses reload", () => {
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
    // @1 has no sid (cockpit terminals carry no sid).
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    const ev = pressCmdR();
    expect(ev.defaultPrevented).toBe(true);
    expect(control.sent.some((m) => m.t === "cockpitTerminal.new")).toBe(false);
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
        cockpitTerminals: [
          cockpitTerminals[0] as CockpitTerminalInfo,
          {
            ...(cockpitTerminals[1] as CockpitTerminalInfo),
            title: "PR を作る",
          },
        ],
        orgs: [],
        orgColors: {},
        orgAliases: {},
      }),
    );
    act(() =>
      control.emit({
        t: "notify",
        kind: "waiting",
        cockpitTerminalId: "@2",
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
        cockpitTerminalId: "@1",
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
        updateCheck: true,
        language: null,
        accountUsage: false,
        editor: null,
        footerThresholds: DEFAULT_FOOTER_THRESHOLDS,
      });
    });
    expect(notifier.isEnabled()).toBe(false);
    act(() => {
      control.emit({
        t: "config.sync",
        notifySound: true,
        updateCheck: true,
        language: null,
        accountUsage: false,
        editor: null,
        footerThresholds: DEFAULT_FOOTER_THRESHOLDS,
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

  it("with 0 cockpitTerminals the main area shows the empty state, which clears when cockpitTerminals arrive", () => {
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
    // Initially (cockpit terminals empty, control open) the main area shows the empty state.
    expect(screen.getByText("セッションがありません")).toBeTruthy();
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
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
        viewStorage={null}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    // Always shown. The footer toggle icons have no session radio.
    expect(inList().getByRole("button", { name: ROW_ZASHIKI })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /セッション一覧/ })).toBeNull();
    // The session list does not disappear when switching to another view (git).
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    expect(listVisible()).toBe(true);
  });

  it("even if the old key zk.views.visibility remains, it is not read and the default explorer is shown", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const storage = {
      getItem: (k: string) =>
        k === "zk.views.visibility"
          ? JSON.stringify({ sourceControl: true, explorer: false })
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
        viewStorage={storage}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
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
        viewStorage={null}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
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

  it("the focused view becomes active and dims the other views", () => {
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
        viewStorage={null}
      />,
    );
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    const mainArea = container.querySelector('[data-view="main"]');
    const sessionList = container.querySelector('[data-view="sessions"]');
    // Initially the main area is active (the session list is dimmed).
    expect(mainArea?.classList.contains("view-inactive")).toBe(false);
    expect(sessionList?.classList.contains("view-inactive")).toBe(true);
    // When the session list gains focus, active moves to it and the main area dims.
    act(() => (sessionList as HTMLElement).focus());
    expect(sessionList?.classList.contains("view-inactive")).toBe(false);
    expect(mainArea?.classList.contains("view-inactive")).toBe(true);
  });

  it("opening a file from the explorer activates the viewer and dims the explorer", async () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    const fsApi: FsApi = {
      repos: () =>
        Promise.resolve({
          repos: [{ org: "org1", repo: "repo-a", path: "/ws/org1/repo-a" }],
        }),
      list: () =>
        Promise.resolve({
          entries: [{ name: "app.ts", kind: "file" }],
          truncated: false,
        }),
      reveal: () => Promise.resolve(),
      rename: (_repoPath, _path, newName) => Promise.resolve(newName),
      delete: () => Promise.resolve(),
    };
    const { container } = render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        viewStorage={null}
      />,
    );
    const repoRow = await screen.findByText("repo-a");
    await act(async () => void fireEvent.click(repoRow));
    const fileRow = await screen.findByText("app.ts");

    // The explorer holds focus before the open (the bug's precondition).
    act(() => (fileRow.closest("button") as HTMLElement).focus());
    const explorer = container.querySelector('[data-view="explorer"]');
    const mainArea = container.querySelector('[data-view="main"]');
    expect(explorer?.classList.contains("view-inactive")).toBe(false);

    // Opening the file moves focus (and the active view) to the viewer.
    await act(async () => void fireEvent.click(fileRow));
    expect(mainArea?.classList.contains("view-inactive")).toBe(false);
    expect(explorer?.classList.contains("view-inactive")).toBe(true);
  });

  it("single selection: only one selected view is shown, and the session list stays permanently pinned", () => {
    const control = createFakeAppControl();
    const { session } = fakeAppSession();
    // Default is explorer. The navigation toggle group (role=radiogroup) switches by single selection.
    const { container } = render(
      <App
        control={control}
        session={session}
        gitApi={fakeGitApi}
        fsApi={fakeFsApi}
        searchApi={fakeSearchApi}
        filesApi={fakeFilesApi}
        reposApi={fakeReposApi}
        viewStorage={null}
      />,
    );
    // The RIGHT column holds the session list and always remains.
    expect(container.querySelector(".right-column")).not.toBeNull();
    expect(listVisible()).toBe(true);
    // The navigation view toggle group exists.
    expect(screen.getByRole("radiogroup", { name: "ビュー切替" })).toBeTruthy();
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

  it("re-clicking the active icon closes the LEFT area while the session list stays pinned", () => {
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
        viewStorage={null}
      />,
    );
    const leftArea = () => container.querySelector(".left-area");
    // The default explorer is open in the LEFT area.
    expect(screen.getByText("EXPLORER")).toBeTruthy();
    expect(leftArea()).not.toBeNull();
    // Re-click the active explorer icon -> the LEFT area closes and all icons become inactive.
    fireEvent.click(screen.getByRole("radio", { name: "エクスプローラー" }));
    expect(screen.queryByText("EXPLORER")).toBeNull();
    expect(leftArea()).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "エクスプローラー" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    // The session list stays permanently pinned in the RIGHT column.
    expect(listVisible()).toBe(true);
    // Re-clicking reopens the LEFT area.
    fireEvent.click(screen.getByRole("radio", { name: "エクスプローラー" }));
    expect(screen.getByText("EXPLORER")).toBeTruthy();
    expect(leftArea()).not.toBeNull();
  });

  it("pressing Ctrl+Alt+E again closes the view (the keyboard also toggles)", () => {
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
        viewStorage={null}
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

  it("pressing a different icon from the closed state re-opens the LEFT area with that view", () => {
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
        viewStorage={null}
      />,
    );
    const leftArea = () => container.querySelector(".left-area");
    // Close explorer -> the LEFT area is gone.
    fireEvent.click(screen.getByRole("radio", { name: "エクスプローラー" }));
    expect(leftArea()).toBeNull();
    // Open git from the closed state -> the LEFT area reopens with git; explorer does not appear.
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    expect(leftArea()).not.toBeNull();
    expect(screen.getByText("SOURCE CONTROL")).toBeTruthy();
    expect(screen.queryByText("EXPLORER")).toBeNull();
  });

  it("the session list lives in the RIGHT column, separate from the LEFT area's selected view", () => {
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
        viewStorage={null}
      />,
    );
    const rightColumn = container.querySelector(".right-column");
    if (rightColumn === null) throw new Error("right-column が無い");
    // The session list is the RIGHT column's content.
    expect(rightColumn.querySelector(".session-list")).not.toBeNull();
    // The default explorer view lives in the LEFT area, not the RIGHT column.
    expect(rightColumn.querySelector('[data-view="explorer"]')).toBeNull();
    expect(
      container.querySelector('.left-area [data-view="explorer"]'),
    ).not.toBeNull();
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
        viewStorage={null}
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

  it("after a footer switch, the sole visible view does not dim", () => {
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
        viewStorage={null}
      />,
    );
    // Move focus to the session list so activeView is something other than explorer.
    const sessionList = container.querySelector('[data-view="sessions"]');
    act(() => (sessionList as HTMLElement).focus());
    // Switching to git makes activeView follow to git at the same time, so it does not dim.
    fireEvent.click(screen.getByRole("radio", { name: "ソース管理" }));
    const sourceControlView = container.querySelector(
      '[data-view="sourceControl"]',
    );
    expect(sourceControlView).not.toBeNull();
    expect(sourceControlView?.classList.contains("view-inactive")).toBe(false);
  });

  it("opens the help modal with Ctrl+Alt+H", () => {
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
        viewStorage={null}
      />,
    );
    expect(screen.queryByRole("dialog", { name: "ヘルプ" })).toBeNull();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", ctrlKey: true, altKey: true }),
      ),
    );
    expect(screen.getByRole("dialog", { name: "ヘルプ" })).toBeTruthy();
  });

  it("opening help closes an open settings modal (peer chrome modals never stack)", () => {
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
        viewStorage={null}
      />,
    );
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true, altKey: true }),
      ),
    );
    expect(screen.getByRole("dialog", { name: "設定" })).toBeTruthy();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", ctrlKey: true, altKey: true }),
      ),
    );
    expect(screen.queryByRole("dialog", { name: "設定" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "ヘルプ" })).toBeTruthy();
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

  it("opens the debug panel from the Settings developer mode", () => {
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
        viewStorage={null}
      />,
    );
    expect(screen.queryByRole("region", { name: "デバッグ情報" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    fireEvent.click(screen.getByRole("tab", { name: "開発モード" }));
    fireEvent.click(
      screen.getByRole("button", { name: "デバッグパネルを開く" }),
    );
    expect(screen.getByRole("region", { name: "デバッグ情報" })).toBeTruthy();
  });

  it("Ctrl+Alt+D no longer opens the debug panel", () => {
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
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", ctrlKey: true, altKey: true }),
      );
    });
    expect(screen.queryByRole("region", { name: "デバッグ情報" })).toBeNull();
  });

  it("suspends the terminal when all cockpitTerminals are deleted and resumes it on revival (suppresses respawn)", () => {
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
    // Has cockpit terminals -> not suspended.
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    expect(f.suspend).not.toHaveBeenCalled();
    // All removed -> suspend (stops work regeneration via reconnect).
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals: [],
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    expect(f.suspend).toHaveBeenCalledTimes(1);
    // Revived -> resume.
    act(() =>
      control.emit({
        t: "state.sync",
        cockpitTerminals,
        orgs: ["kilo"],
        orgColors: {},
        orgAliases: {},
      }),
    );
    expect(f.resume).toHaveBeenCalled();
  });
});
