// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { SessionInfo } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionListPanel } from "./SessionListPanel.js";

const SID1 = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
const SID2 = "11111111-2222-4333-8444-555566667777";
const SID3 = "22222222-3333-4444-8555-666677778888";

const sessions: SessionInfo[] = [
  {
    windowId: "@1",
    name: "zashiki",
    org: "kilo",
    repo: "zashiki",
    state: "running",
    title: "issue #5 を実装して",
    sid: SID1,
    active: true,
  },
  {
    windowId: "@2",
    name: "tango",
    org: "kilo",
    repo: "tango",
    state: "idle",
    title: null,
    sid: SID2,
    active: false,
  },
  {
    windowId: "@3",
    name: "charlie-app",
    org: "charlie",
    repo: "charlie-app",
    state: "waiting_input",
    title: "チケットの調査",
    sid: SID3,
    active: false,
  },
];

const orgs = ["kilo", "charlie", "delta"];

function renderPanel(
  overrides: Partial<Parameters<typeof SessionListPanel>[0]> = {},
) {
  const props = {
    sessions,
    orgs,
    selectedWindowId: null as string | null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onClose: vi.fn(),
    onRefresh: vi.fn(),
    onFocusTerminal: vi.fn(),
    ...overrides,
  };
  render(<SessionListPanel {...props} />);
  return props;
}

afterEach(cleanup);

describe("SessionListPanel: org collapsible group display", () => {
  it("groups by org under a ▼ org (count) header", () => {
    renderPanel();
    expect(screen.getByText("▼ kilo (2)")).toBeTruthy();
    expect(screen.getByText("▼ charlie (1)")).toBeTruthy();
  });

  it("always shows an org with 0 sessions as (0) too (all orgs from repos.conf)", () => {
    renderPanel();
    expect(screen.getByText("▼ delta (0)")).toBeTruthy();
  });

  it("shows sessions from an org not in orgs as a detected group", () => {
    renderPanel({
      sessions: [
        { ...sessions[0], org: "scratch", windowId: "@9" } as SessionInfo,
      ],
    });
    expect(screen.getByText("▼ scratch (1)")).toBeTruthy();
  });

  it("collapses (▶) on clicking the org header, hiding the session rows", () => {
    renderPanel();
    fireEvent.click(screen.getByText("▼ kilo (2)"));
    expect(screen.getByText("▶ kilo (2)")).toBeTruthy();
    expect(screen.queryByText("issue #5 を実装して")).toBeNull();
    // Clicking again returns to expanded
    fireEvent.click(screen.getByText("▶ kilo (2)"));
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
  });
});

describe("SessionListPanel: org header color", () => {
  it("colors the org header via auto-coloring even without orgColors", () => {
    renderPanel();
    const header = screen.getByText("▼ kilo (2)") as HTMLElement;
    expect(header.style.color).not.toBe("");
  });

  it("prefers an explicit repos.conf color over auto-coloring", () => {
    renderPanel({ orgColors: { charlie: "#98c379" } });
    const charlie = screen.getByText("▼ charlie (1)") as HTMLElement;
    const kilo = screen.getByText("▼ kilo (2)") as HTMLElement;
    expect(charlie.style.color).toBe("rgb(152, 195, 121)");
    // An org with no explicit color is always colored via auto-coloring too
    expect(kilo.style.color).not.toBe("");
  });
});

describe("SessionListPanel: repos.conf not-configured guidance", () => {
  it("shows guidance to create repos.conf instead of an empty panel when there are 0 orgs", () => {
    renderPanel({ sessions: [], orgs: [] });
    expect(screen.getByText("~/.zashiki/repos.conf")).toBeTruthy();
    // Includes an example in the one-path-per-line format
    expect(screen.getByText(/1行1パス/)).toBeTruthy();
    expect(
      screen.getByText(/\/Users\/you\/workspace\/org1\/repo-a/),
    ).toBeTruthy();
  });

  it("does not show the guidance when there is at least one org", () => {
    renderPanel({ sessions: [], orgs: ["kilo"] });
    expect(screen.queryByText("~/.zashiki/repos.conf")).toBeNull();
  });

  it("does not show the guidance when a detected session's org exists even if orgs is empty", () => {
    renderPanel({ sessions: [sessions[0] as SessionInfo], orgs: [] });
    expect(screen.queryByText("~/.zashiki/repos.conf")).toBeNull();
    expect(screen.getByText("▼ kilo (1)")).toBeTruthy();
  });

  it("does not show the guidance even with 0 orgs when control is disconnected (avoids confusion with a connection issue)", () => {
    renderPanel({ sessions: [], orgs: [], connected: false });
    expect(screen.queryByText("~/.zashiki/repos.conf")).toBeNull();
  });
});

describe("SessionListPanel: session rows", () => {
  it("displays the state icon (Material Symbols) with a state class", () => {
    renderPanel({
      sessions: [
        { ...sessions[0], state: "waiting_input" } as SessionInfo,
        { ...sessions[1], state: "running" } as SessionInfo,
        {
          ...sessions[2],
          state: "no_claude",
          org: "kilo",
        } as SessionInfo,
      ],
    });
    const waiting = screen.getByText("add_alert");
    expect(waiting.className).toContain("state-waiting_input");
    expect(waiting.className).toContain("material-symbols-outlined");
    const running = screen.getByText("hourglass");
    expect(running.className).toContain("state-running");
    const none = screen.getByText("terminal_2");
    expect(none.className).toContain("state-no_claude");
  });

  it("displays the pending icon with a state class while starting", () => {
    renderPanel({
      sessions: [{ ...sessions[0], state: "starting" } as SessionInfo],
    });
    const starting = screen.getByText("pending");
    expect(starting.className).toContain("state-starting");
    expect(starting.className).toContain("material-symbols-outlined");
  });

  it("overlays robot_2 on the hourglass while a subagent is running", () => {
    renderPanel({
      sessions: [{ ...sessions[1], state: "running_bg_agent" } as SessionInfo],
    });
    const base = screen.getByText("hourglass");
    const stack = base.parentElement;
    expect(stack?.className).toContain("state-running_bg_agent");
    expect(stack?.className).toContain("state-stack");
    const badge = screen.getByText("robot_2");
    expect(badge.className).toContain("state-bg-agent-badge");
    expect(badge.className).toContain("material-symbols-outlined");
  });

  it("appends the running total (+N) while a subagent is running", () => {
    renderPanel({
      sessions: [
        {
          ...sessions[1],
          state: "running_bg_agent",
          runningSubagents: 13,
        } as SessionInfo,
      ],
    });
    const count = screen.getByText("(+13)");
    expect(count.className).toContain("session-bg-count");
  });

  it("does not show (+N) when N=0 or in a non-bg state", () => {
    renderPanel({
      sessions: [
        {
          ...sessions[1],
          state: "running_bg_agent",
          runningSubagents: 0,
        } as SessionInfo,
        {
          ...sessions[0],
          state: "running",
          runningSubagents: 5,
        } as SessionInfo,
      ],
    });
    expect(screen.queryByText(/\(\+\d+\)/)).toBeNull();
  });

  it("overlays a deployed_code badge at the bottom-left for a row with a persistent bg shell", () => {
    renderPanel({
      sessions: [
        { ...sessions[0], state: "running", shellsRunning: 1 } as SessionInfo,
      ],
    });
    const badge = screen.getByText("deployed_code");
    expect(badge.className).toContain("state-shell-badge");
    expect(badge.className).toContain("material-symbols-outlined");
  });

  it("can display robot_2 (bottom-right) and deployed_code (bottom-left) at once (orthogonal to the primary state)", () => {
    renderPanel({
      sessions: [
        {
          ...sessions[0],
          state: "running_bg_agent",
          runningSubagents: 2,
          shellsRunning: 3,
        } as SessionInfo,
      ],
    });
    expect(screen.getByText("robot_2").className).toContain(
      "state-bg-agent-badge",
    );
    expect(screen.getByText("deployed_code").className).toContain(
      "state-shell-badge",
    );
  });

  it("does not show the shell badge when shellsRunning is 0/undefined", () => {
    renderPanel({
      sessions: [
        { ...sessions[0], state: "running", shellsRunning: 0 } as SessionInfo,
        { ...sessions[1] } as SessionInfo,
      ],
    });
    expect(screen.queryByText("deployed_code")).toBeNull();
  });

  it("overlays an error badge at the top-right for a row that hit the usage limit", () => {
    renderPanel({
      sessions: [
        { ...sessions[0], state: "running", limited: true } as SessionInfo,
      ],
    });
    const badge = screen.getByText("error");
    expect(badge.className).toContain("state-limited-badge");
    expect(badge.className).toContain("material-symbols-outlined");
  });

  it("does not show the limit badge when limited is false/undefined", () => {
    renderPanel({
      sessions: [
        { ...sessions[0], state: "running", limited: false } as SessionInfo,
        { ...sessions[1] } as SessionInfo,
      ],
    });
    expect(screen.queryByText("error")).toBeNull();
  });

  it("displays idle with conversation history using check", () => {
    renderPanel({
      sessions: [{ ...sessions[1], title: "調査タスク" } as SessionInfo],
    });
    expect(screen.getByText("check").className).toContain("state-idle");
  });

  it("distinguishes a new/unused session (idle with no title) using start", () => {
    // tango is idle with title:null (zero conversation history)
    renderPanel({ sessions: [sessions[1] as SessionInfo] });
    const fresh = screen.getByText("start");
    expect(fresh.className).toContain("state-fresh");
    expect(screen.queryByText("check")).toBeNull();
  });

  it("shows the summary title in the row and does not visibly show the redundant org name (name)", () => {
    renderPanel();
    // The title is shown visibly
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
    // The name, obvious from the collapse header, is not shown in the row body (not in textContent)
    const row = screen.getByRole("button", {
      name: /zashiki issue #5 を実装して/,
    });
    expect(row.textContent).not.toContain("zashiki");
    // Keep the window name in aria-label for identification and a11y
    expect(row.getAttribute("aria-label")).toBe("zashiki issue #5 を実装して");
  });

  it("makes the aria-label the window name only for a row without a title", () => {
    renderPanel();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    expect(row.getAttribute("aria-label")).toBe("tango");
  });

  it("indicates the active window with a subtle row highlight (class) rather than a >", () => {
    renderPanel();
    const active = screen.getByRole("button", { name: /zashiki(?! を閉じる)/ });
    expect(active.className).toContain("session-row-active");
    expect(active.textContent).not.toContain(">");
    const inactive = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    expect(inactive.className).not.toContain("session-row-active");
    expect(inactive.textContent).not.toContain(">");
  });

  it("a row that is both active and selected has session-row-active and aria-current together", () => {
    renderPanel({ selectedWindowId: "@1" });
    const row = screen.getByRole("button", { name: /zashiki(?! を閉じる)/ });
    expect(row.className).toContain("session-row-active");
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("calls onSelect(windowId) on double-click", () => {
    const props = renderPanel();
    fireEvent.doubleClick(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    expect(props.onSelect).toHaveBeenCalledWith("@2");
  });

  it("does not expand on a single click (does not call onSelect); only applies the focus ring", () => {
    const props = renderPanel();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(row.className).toContain("session-row-focused");
  });

  it("a single click on the selected row is a no-op (does not move the focus ring either)", () => {
    const props = renderPanel({ selectedWindowId: "@2" });
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(row.className).not.toContain("session-row-focused");
  });

  it("does not expand on two consecutive single clicks on the same row (not treated as a double-click); core of misfire prevention", () => {
    const props = renderPanel();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    fireEvent.click(row);
    fireEvent.click(row);
    // Two single clicks (no synthesized dblclick) must not expand = prohibit regressing to a two-step interaction
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("a double-click on the currently shown (selected) row does not resend onSelect (idempotency guard)", () => {
    const props = renderPanel({ selectedWindowId: "@2" });
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    fireEvent.doubleClick(row);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("shows a discoverability title on the row button (double-click/Enter)", () => {
    renderPanel();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    expect(row.getAttribute("title")).toContain("ダブルクリック");
  });

  it("collapses the focus ring after expanding on double-click (delegates to the selection highlight)", () => {
    renderPanel();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    // Single click applies the focus ring -> double click expands and collapses the ring
    fireEvent.click(row);
    expect(row.className).toContain("session-row-focused");
    fireEvent.doubleClick(row);
    expect(row.className).not.toContain("session-row-focused");
  });

  it("adds aria-current to the selected row", () => {
    renderPanel({ selectedWindowId: "@2" });
    expect(
      screen
        .getByRole("button", { name: /tango(?! を閉じる)/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });
});

describe("SessionListPanel: applying manual titles", () => {
  it("visibly shows the manual title from conversationTitles in the row (immediate reflection of header rename)", () => {
    renderPanel({
      conversationTitles: {
        [SID2]: { title: "デプロイ調査", name: "tango" },
      },
    });
    expect(screen.getByText("デプロイ調査")).toBeTruthy();
  });

  it("prefers the manual title over the automatic title", () => {
    renderPanel({
      conversationTitles: {
        [SID1]: { title: "手で付けた名前", name: "zashiki" },
      },
    });
    expect(screen.getByText("手で付けた名前")).toBeTruthy();
    expect(screen.queryByText("issue #5 を実装して")).toBeNull();
  });

  it("reflects the manual title in the aria-label too", () => {
    renderPanel({
      conversationTitles: {
        [SID1]: { title: "手で付けた名前", name: "zashiki" },
      },
    });
    const row = screen.getByRole("button", { name: /手で付けた名前/ });
    expect(row.getAttribute("aria-label")).toBe("zashiki 手で付けた名前");
  });

  it("does not apply a manual title whose saved name does not match the current session (a safeguard for sid collisions and duplicate resumes)", () => {
    renderPanel({
      conversationTitles: {
        [SID1]: { title: "別リポの名残", name: "other-repo" },
      },
    });
    expect(screen.queryByText("別リポの名残")).toBeNull();
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
  });

  it("removes the fresh (start) treatment when a manual title is given to a fresh session (idle, no title)", () => {
    // tango is idle with title:null (originally fresh = start icon)
    renderPanel({
      conversationTitles: {
        [SID2]: { title: "新しい調査", name: "tango" },
      },
    });
    expect(screen.getByText("新しい調査")).toBeTruthy();
    expect(screen.queryByText("start")).toBeNull();
    expect(screen.getByText("check").className).toContain("state-idle");
  });
});

describe("SessionListPanel: focusing the terminal on double-click/Enter", () => {
  const panel = () => screen.getByRole("complementary");
  const rowFor = (name: string) =>
    screen.getByRole("button", {
      name: new RegExp(`${name}(?! を閉じる)`),
    }) as HTMLElement;

  it("calls onSelect and onFocusTerminal on double-clicking a different session", () => {
    const props = renderPanel();
    fireEvent.doubleClick(rowFor("tango"));
    expect(props.onSelect).toHaveBeenCalledWith("@2");
    expect(props.onFocusTerminal).toHaveBeenCalled();
  });

  it("does not resend onSelect on double-clicking the shown session but still calls onFocusTerminal", () => {
    const props = renderPanel({ selectedWindowId: "@2" });
    fireEvent.doubleClick(rowFor("tango"));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onFocusTerminal).toHaveBeenCalled();
  });

  it("calls onFocusTerminal when opening the focused row with Enter too", () => {
    const props = renderPanel();
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @1
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @2
    fireEvent.keyDown(panel(), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith("@2");
    expect(props.onFocusTerminal).toHaveBeenCalled();
  });
});

describe("SessionListPanel: right-click menu", () => {
  it("always shows a visible + new button on each org header (including empty orgs)", () => {
    renderPanel();
    expect(
      screen.getByRole("button", { name: "kilo に新規セッション" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "charlie に新規セッション" }),
    ).toBeTruthy();
    // Show + on an org with 0 sessions (delta) too (that's exactly where the new-session entry point is needed)
    expect(
      screen.getByRole("button", { name: "delta に新規セッション" }),
    ).toBeTruthy();
  });

  it("calls onNew(org) for that org on clicking the + on the org header", () => {
    const props = renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "charlie に新規セッション" }),
    );
    expect(props.onNew).toHaveBeenCalledWith("charlie");
  });

  it("clicking the + on the org header does not propagate to the collapse toggle (does not change the collapse state)", () => {
    renderPanel();
    // Precondition: kilo is expanded (▼) and its session rows are visible
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "kilo に新規セッション" }),
    );
    // Stays expanded after pressing + (not accidentally collapsed)
    expect(screen.getByText("▼ kilo (2)")).toBeTruthy();
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
  });

  it("clicking the + on the org header does not trigger row selection (onSelect)", () => {
    const props = renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "kilo に新規セッション" }),
    );
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("shows a ✕ button at the right end of each row", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "tango を閉じる" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "zashiki を閉じる" }),
    ).toBeTruthy();
  });

  it("calls onClose(windowId) immediately on clicking the row ✕ without a confirmation", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "tango を閉じる" }));
    expect(props.onClose).toHaveBeenCalledWith("@2");
    // Does not show the confirmation bar (same behavior as right-click Delete)
    expect(
      screen.queryByRole("button", { name: "tango を閉じる（確定）" }),
    ).toBeNull();
  });

  it("clicking the row ✕ does not trigger row selection (onSelect)", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "tango を閉じる" }));
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("wires each row's ✕ to its own row's windowId (no misconnection to another row)", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "zashiki を閉じる" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledWith("@1");
  });

  it("right-clicking the org header and choosing 'New session' calls onNew(org)", () => {
    const props = renderPanel();
    fireEvent.contextMenu(screen.getByText("▼ charlie (1)"));
    fireEvent.click(screen.getByRole("menuitem", { name: "新規セッション" }));
    expect(props.onNew).toHaveBeenCalledWith("charlie");
  });

  it("shows 'Delete' but not 'New session' in the row right-click menu", () => {
    renderPanel();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    expect(screen.getByRole("menuitem", { name: "削除" })).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "新規セッション" }),
    ).toBeNull();
  });

  it("right-clicking the row and choosing 'Delete' calls onClose(windowId) immediately without a confirmation", () => {
    const props = renderPanel();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(props.onClose).toHaveBeenCalledWith("@2");
    // Does not show the confirmation bar
    expect(
      screen.queryByRole("button", { name: "tango を閉じる（確定）" }),
    ).toBeNull();
  });

  it("closes the menu after choosing Delete", () => {
    renderPanel();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("closes the menu after choosing a menu item", () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByText("▼ charlie (1)"));
    fireEvent.click(screen.getByRole("menuitem", { name: "新規セッション" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("closes the menu on a background click", () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByText("▼ charlie (1)"));
    expect(
      screen.getByRole("menuitem", { name: "新規セッション" }),
    ).toBeTruthy();
    const backdrop = document.querySelector(".session-context-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("right-clicking a row with a sid and choosing 'Copy session (resume)' calls onCopyResume(windowId)", () => {
    const withSid: SessionInfo[] = [
      { ...sessions[1], sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f" },
    ] as SessionInfo[];
    const props = renderPanel({
      sessions: withSid,
      onCopyResume: vi.fn(),
    });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    const item = screen.getByRole("menuitem", {
      name: "セッションをコピー（resume）",
    });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item);
    expect(props.onCopyResume).toHaveBeenCalledWith("@2");
    // The menu closes after selection
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("disables 'Copy session (resume)' for a row without a sid", () => {
    const noSid: SessionInfo[] = [
      { ...sessions[1], sid: undefined },
    ] as SessionInfo[];
    renderPanel({ sessions: noSid, onCopyResume: vi.fn() });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    const item = screen.getByRole("menuitem", {
      name: "セッションをコピー（resume）",
    });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not show the resume item when onCopyResume is not provided (backward compatibility)", () => {
    renderPanel();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "セッションをコピー（resume）" }),
    ).toBeNull();
    expect(screen.getByRole("menuitem", { name: "削除" })).toBeTruthy();
  });

  it("clears the confirmation state when the target session disappears while the confirmation bar (Ctrl-X) is shown", () => {
    const props = {
      sessions,
      orgs,
      selectedWindowId: "@2" as string | null,
      onSelect: vi.fn(),
      onNew: vi.fn(),
      onClose: vi.fn(),
      onRefresh: vi.fn(),
      onSave: vi.fn(),
      onRestore: vi.fn(),
    };
    const { rerender } = render(<SessionListPanel {...props} />);
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "x",
      ctrlKey: true,
    });
    expect(
      screen.getByRole("button", { name: "tango を閉じる（確定）" }),
    ).toBeTruthy();
    // @2 disappears -> the confirmation state is also cleared, and the confirmation bar isn't re-shown even if @2 returns
    const without = sessions.filter((s) => s.windowId !== "@2");
    rerender(<SessionListPanel {...props} sessions={without} />);
    rerender(<SessionListPanel {...props} sessions={sessions} />);
    expect(
      screen.queryByRole("button", { name: "tango を閉じる（確定）" }),
    ).toBeNull();
  });
});

describe("SessionListPanel: operations", () => {
  it("calls onRefresh via the refresh button", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "一覧を更新" }));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it("does not show a status when onRefresh returns void (synchronous), keeping fire-and-forget compatibility", () => {
    const props = renderPanel({ onRefresh: vi.fn() });
    const btn = screen.getByRole("button", { name: "一覧を更新" });
    fireEvent.click(btn);
    expect(props.onRefresh).toHaveBeenCalled();
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(btn.textContent).toBe("↻");
  });

  it("shows a spinner (aria-busy) while fetching and ↻ on resolution when onRefresh returns a Promise", async () => {
    let resolve: (() => void) | undefined;
    const onRefresh = () =>
      new Promise<void>((r) => {
        resolve = r;
      });
    renderPanel({ onRefresh });
    const btn = screen.getByRole("button", { name: "一覧を更新" });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.querySelector(".panel-refresh-spinner")).not.toBeNull();
    await act(async () => {
      resolve?.();
    });
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(btn.textContent).toBe("↻");
  });

  it("shows ⚠ in the header with the error in title when onRefresh rejects", async () => {
    let reject: ((e: unknown) => void) | undefined;
    const onRefresh = () =>
      new Promise<void>((_resolve, r) => {
        reject = r;
      });
    renderPanel({ onRefresh });
    const btn = screen.getByRole("button", { name: "一覧を更新" });
    fireEvent.click(btn);
    await act(async () => {
      reject?.(new Error("未接続です"));
    });
    expect(btn.textContent).toContain("⚠");
    expect(btn.getAttribute("title")).toContain("未接続です");
  });

  it("Ctrl-N calls onNew with the selected session's org", () => {
    const props = renderPanel({ selectedWindowId: "@3" });
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "n",
      ctrlKey: true,
    });
    expect(props.onNew).toHaveBeenCalledWith("charlie");
  });

  it("Ctrl-N calls onNew with the first org when nothing is selected", () => {
    const props = renderPanel();
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "n",
      ctrlKey: true,
    });
    expect(props.onNew).toHaveBeenCalledWith("kilo");
  });

  it("Ctrl-X opens the inline confirmation for the selected session and closes it on confirm", () => {
    const props = renderPanel({ selectedWindowId: "@2" });
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "x",
      ctrlKey: true,
    });
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "tango を閉じる（確定）" }),
    );
    expect(props.onClose).toHaveBeenCalledWith("@2");
  });

  it("Ctrl-X does nothing when nothing is selected", () => {
    const props = renderPanel();
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "x",
      ctrlKey: true,
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("SessionListPanel: arrow-key navigation (flattened)", () => {
  const panel = () => screen.getByRole("complementary");
  const rowFor = (name: string) =>
    screen.getByRole("button", {
      name: new RegExp(`${name}(?! を閉じる)`),
    }) as HTMLElement;
  const orgHeader = (label: string) => screen.getByText(label) as HTMLElement;

  it("the first ↓ move puts the focus ring on the first org header (does not switch the terminal)", () => {
    const props = renderPanel();
    fireEvent.keyDown(panel(), { key: "ArrowDown" });
    expect(orgHeader("▼ kilo (2)").className).toContain("session-org-focused");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("↓ moves flatly and continuously across org headers and their rows (org→@1→@2→org(charlie)→@3)", () => {
    renderPanel();
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // org kilo
    expect(orgHeader("▼ kilo (2)").className).toContain("session-org-focused");
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @1
    expect(rowFor("zashiki").className).toContain("session-row-focused");
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @2
    expect(rowFor("tango").className).toContain("session-row-focused");
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // org charlie
    expect(orgHeader("▼ charlie (1)").className).toContain(
      "session-org-focused",
    );
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @3
    expect(rowFor("charlie-app").className).toContain("session-row-focused");
  });

  it("calls onSelect on Enter while a session row is focused", () => {
    const props = renderPanel();
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @1
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @2
    fireEvent.keyDown(panel(), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith("@2");
  });

  it("toggles the collapse on Enter while an org header is focused (does not call onSelect)", () => {
    const props = renderPanel();
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(panel(), { key: "Enter" }); // collapse
    expect(screen.getByText("▶ kilo (2)")).toBeTruthy();
    expect(screen.queryByText("issue #5 を実装して")).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("expands a collapsed org header on Enter while it is focused", () => {
    renderPanel();
    fireEvent.click(screen.getByText("▼ kilo (2)")); // collapse (clicking also moves focused to the org)
    expect(screen.queryByText("issue #5 を実装して")).toBeNull();
    fireEvent.keyDown(panel(), { key: "Enter" }); // expand the already-focused org
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
  });

  it("puts the focus ring (session-org-focused) on clicking the org header", () => {
    renderPanel();
    fireEvent.click(screen.getByText("▼ charlie (1)")); // collapse (▶) + focus ring
    expect(orgHeader("▶ charlie (1)").className).toContain(
      "session-org-focused",
    );
  });

  it("does not toggle on the aside side for an Enter arriving directly on the org header button (delegated to the native click to prevent a double toggle)", () => {
    renderPanel();
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // focused=org kilo (expanded)
    // Simulate the real DOM focus being on the org button, and send Enter with the button as target.
    // If the aside handles it, it opens together with the native click and immediately closes, so the aside skips it.
    fireEvent.keyDown(orgHeader("▼ kilo (2)"), { key: "Enter" });
    // The aside doesn't perform the collapse (delegated to the native button click path) = stays ▼.
    expect(screen.getByText("▼ kilo (2)")).toBeTruthy();
  });

  it("adds aria-expanded (expansion state) to the org header", () => {
    renderPanel();
    expect(orgHeader("▼ kilo (2)").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByText("▼ kilo (2)"));
    expect(orgHeader("▶ kilo (2)").getAttribute("aria-expanded")).toBe("false");
  });

  it("anchors ↑↓ at the selected row when no focus is set (moves to the row after the selected one)", () => {
    renderPanel({ selectedWindowId: "@2" });
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // next after @2 = org charlie
    expect(orgHeader("▼ charlie (1)").className).toContain(
      "session-org-focused",
    );
  });

  it("anchors ↑↓ at the org header when the selected row is inside a collapsed org with no focus (does not jump to the list edge)", () => {
    renderPanel({ selectedWindowId: "@2" });
    fireEvent.click(screen.getByText("▼ kilo (2)")); // collapse @2's org (focused=org kilo)
    fireEvent.doubleClick(rowFor("charlie-app")); // select(@3): reset focused=null (the selected prop stays @2)
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // anchor=org kilo -> next org charlie
    expect(orgHeader("▼ charlie (1)").className).toContain(
      "session-org-focused",
    );
  });

  it("↑ at the top stays at the top (the first org header); clamps at the edge", () => {
    renderPanel();
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(panel(), { key: "ArrowUp" }); // stays at the top
    expect(orgHeader("▼ kilo (2)").className).toContain("session-org-focused");
  });

  it("excludes rows under a collapsed org from focus movement (the header remains)", () => {
    renderPanel();
    fireEvent.click(screen.getByText("▼ kilo (2)")); // collapse @1/@2, focused=org kilo
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // skip the child rows to the next org charlie
    expect(orgHeader("▼ charlie (1)").className).toContain(
      "session-org-focused",
    );
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @3
    expect(rowFor("charlie-app").className).toContain("session-row-focused");
  });

  it("Enter does nothing when nothing is focused", () => {
    const props = renderPanel();
    fireEvent.keyDown(panel(), { key: "Enter" });
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("does not select the focused row on Enter after collapsing its org (misfire prevention)", () => {
    const props = renderPanel();
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @1
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @2
    fireEvent.click(screen.getByText("▼ kilo (2)")); // collapse -> @2 invisible, focused moves to the org
    fireEvent.keyDown(panel(), { key: "Enter" }); // expands the org, not selects @2
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("does not select on the IME composition-confirming Enter (isComposing)", () => {
    const props = renderPanel();
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(panel(), { key: "ArrowDown" }); // @1 row
    fireEvent.keyDown(panel(), { key: "Enter", isComposing: true });
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});

describe("SessionListPanel: header", () => {
  it("labels the header SESSION LIST (no save/restore buttons; already automated)", () => {
    renderPanel();
    expect(screen.getByText("SESSION LIST")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "セッションを保存" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "セッションを復元" }),
    ).toBeNull();
  });
});

describe("SessionListPanel: empty state", () => {
  it("does not show an empty state in the list even with 0 sessions (moved to the conversation panel)", () => {
    renderPanel({ sessions: [], orgs: ["kilo"] });
    expect(screen.queryByText("セッションがありません")).toBeNull();
    // Show org headers (the right-click entry point for new sessions) as before
    expect(screen.getByText("▼ kilo (0)")).toBeTruthy();
  });
});

describe("SessionListPanel: add-org header button", () => {
  it("renders the plus button only when onAddOrg is given and calls it on click", () => {
    const onAddOrg = vi.fn();
    renderPanel({ onAddOrg });
    const btn = screen.getByRole("button", { name: "組織を追加" });
    fireEvent.click(btn);
    expect(onAddOrg).toHaveBeenCalled();
  });

  it("hides the plus button when onAddOrg is omitted", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "組織を追加" })).toBeNull();
  });
});

describe("SessionListPanel: Rename", () => {
  const rowFor = (name: string) =>
    screen.getByRole("button", {
      name: new RegExp(`${name}(?! を閉じる)`),
    }) as HTMLElement;
  const renameInput = () =>
    screen.getByRole("textbox", {
      name: "セッションのタイトルを編集",
    }) as HTMLInputElement;

  it("shows 'Rename' in the row right-click menu when onRename is provided", () => {
    renderPanel({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    expect(screen.getByRole("menuitem", { name: "名前を変更" })).toBeTruthy();
  });

  it("does not show 'Rename' when onRename is not provided (backward compatibility)", () => {
    renderPanel();
    fireEvent.contextMenu(rowFor("tango"));
    expect(screen.queryByRole("menuitem", { name: "名前を変更" })).toBeNull();
  });

  it("choosing 'Rename' shows an input prefilled with the current title, and Enter after changing the value calls onRename(sid, name, value)", () => {
    const props = renderPanel({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("zashiki"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    const input = renameInput();
    expect(input.value).toBe("issue #5 を実装して");
    fireEvent.change(input, { target: { value: "新しいタイトル" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith(
      SID1,
      "zashiki",
      "新しいタイトル",
    );
  });

  it("prefills the input with the manual title for a row that has one", () => {
    const props = renderPanel({
      onRename: vi.fn(),
      conversationTitles: {
        [SID2]: { title: "手で付けた名前", name: "tango" },
      },
    });
    fireEvent.contextMenu(rowFor("手で付けた名前"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    expect(renameInput().value).toBe("手で付けた名前");
    fireEvent.change(renameInput(), { target: { value: "別名" } });
    fireEvent.keyDown(renameInput(), { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith(SID2, "tango", "別名");
  });

  it("uses the name as the initial value for a fresh row with neither a title nor a manual title", () => {
    renderPanel({
      onRename: vi.fn(),
      sessions: [{ ...sessions[1], title: null } as SessionInfo],
    });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    expect(renameInput().value).toBe("tango");
  });

  it("cancels on Escape (does not call onRename; the input disappears)", () => {
    const props = renderPanel({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    fireEvent.change(renameInput(), { target: { value: "捨てる名前" } });
    fireEvent.keyDown(renameInput(), { key: "Escape" });
    expect(props.onRename).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "セッションのタイトルを編集" }),
    ).toBeNull();
  });

  it("commits on blur", () => {
    const props = renderPanel({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    fireEvent.change(renameInput(), { target: { value: "確定名" } });
    fireEvent.blur(renameInput());
    expect(props.onRename).toHaveBeenCalledWith(SID2, "tango", "確定名");
  });

  it("closes the menu after choosing 'Rename'", () => {
    renderPanel({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("disables 'Rename' for a row without a sid (same as tab renaming)", () => {
    renderPanel({
      onRename: vi.fn(),
      sessions: [{ ...sessions[1], sid: undefined } as SessionInfo],
    });
    fireEvent.contextMenu(rowFor("tango"));
    const item = screen.getByRole("menuitem", { name: "名前を変更" });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not propagate Enter during editing to row selection (onSelect)", () => {
    const props = renderPanel({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    fireEvent.change(renameInput(), { target: { value: "名前" } });
    fireEvent.keyDown(renameInput(), { key: "Enter" });
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("aborts editing when the target session disappears", () => {
    const props = {
      sessions,
      orgs,
      selectedWindowId: null as string | null,
      onSelect: vi.fn(),
      onNew: vi.fn(),
      onClose: vi.fn(),
      onRefresh: vi.fn(),
      onRename: vi.fn(),
    };
    const { rerender } = render(<SessionListPanel {...props} />);
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    expect(
      screen.getByRole("textbox", { name: "セッションのタイトルを編集" }),
    ).toBeTruthy();
    const without = sessions.filter((s) => s.windowId !== "@2");
    rerender(<SessionListPanel {...props} sessions={without} />);
    expect(
      screen.queryByRole("textbox", { name: "セッションのタイトルを編集" }),
    ).toBeNull();
    expect(props.onRename).not.toHaveBeenCalled();
  });
});
