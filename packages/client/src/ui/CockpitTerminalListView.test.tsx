// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CockpitTerminalInfo } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CockpitTerminalListView } from "./CockpitTerminalListView.js";

const SID1 = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
const SID2 = "11111111-2222-4333-8444-555566667777";
const SID3 = "22222222-3333-4444-8555-666677778888";

const cockpitTerminals: CockpitTerminalInfo[] = [
  {
    cockpitTerminalId: SID1,
    name: "zashiki",
    org: "kilo",
    repo: "zashiki",
    state: "running",
    title: "issue #5 を実装して",
    sid: SID1,
    active: true,
  },
  {
    cockpitTerminalId: SID2,
    name: "tango",
    org: "kilo",
    repo: "tango",
    state: "idle",
    title: null,
    sid: SID2,
    active: false,
  },
  {
    cockpitTerminalId: SID3,
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

function renderView(
  overrides: Partial<Parameters<typeof CockpitTerminalListView>[0]> = {},
) {
  const props = {
    cockpitTerminals,
    orgs,
    selectedCockpitTerminalId: null as string | null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onClose: vi.fn(),
    onFocusTerminal: vi.fn(),
    ...overrides,
  };
  render(<CockpitTerminalListView {...props} />);
  return props;
}

afterEach(cleanup);

describe("CockpitTerminalListView: org collapsible group display", () => {
  it("groups by org under an org (count) header", () => {
    renderView();
    expect(screen.getByText("kilo (2)")).toBeTruthy();
    expect(screen.getByText("charlie (1)")).toBeTruthy();
  });

  it("always shows an org with 0 cockpitTerminals as (0) too (all orgs from repos.conf)", () => {
    renderView();
    expect(screen.getByText("delta (0)")).toBeTruthy();
  });

  it("shows cockpitTerminals from an org not in orgs as a detected group", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          org: "scratch",
          cockpitTerminalId: "@9",
        } as CockpitTerminalInfo,
      ],
    });
    expect(screen.getByText("scratch (1)")).toBeTruthy();
  });

  it("collapses on clicking the org header, hiding the session rows", () => {
    renderView();
    const header = () => screen.getByRole("button", { name: "kilo (2)" });
    expect(header().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByText("kilo (2)"));
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("issue #5 を実装して")).toBeNull();
    // Clicking again returns to expanded
    fireEvent.click(screen.getByText("kilo (2)"));
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
  });
});

describe("CockpitTerminalListView: org header color", () => {
  it("colors the org header via auto-coloring even without orgColors", () => {
    renderView();
    const header = screen.getByRole("button", { name: "kilo (2)" });
    expect(header.style.color).not.toBe("");
  });

  it("prefers an explicit repos.conf color over auto-coloring", () => {
    renderView({ orgColors: { charlie: "#98c379" } });
    const charlie = screen.getByRole("button", { name: "charlie (1)" });
    const kilo = screen.getByRole("button", { name: "kilo (2)" });
    expect(charlie.style.color).toBe("rgb(152, 195, 121)");
    // An org with no explicit color is always colored via auto-coloring too
    expect(kilo.style.color).not.toBe("");
  });
});

describe("CockpitTerminalListView: repos.conf not-configured guidance", () => {
  it("shows guidance to create repos.conf instead of an empty view when there are 0 orgs", () => {
    renderView({ cockpitTerminals: [], orgs: [] });
    expect(screen.getByText("~/.zashiki/repos.conf")).toBeTruthy();
    // Includes an example in the one-path-per-line format
    expect(screen.getByText(/1行1パス/)).toBeTruthy();
    expect(
      screen.getByText(/\/Users\/you\/workspace\/org1\/repo-a/),
    ).toBeTruthy();
  });

  it("does not show the guidance when there is at least one org", () => {
    renderView({ cockpitTerminals: [], orgs: ["kilo"] });
    expect(screen.queryByText("~/.zashiki/repos.conf")).toBeNull();
  });

  it("does not show the guidance when a detected session's org exists even if orgs is empty", () => {
    renderView({
      cockpitTerminals: [cockpitTerminals[0] as CockpitTerminalInfo],
      orgs: [],
    });
    expect(screen.queryByText("~/.zashiki/repos.conf")).toBeNull();
    expect(screen.getByText("kilo (1)")).toBeTruthy();
  });

  it("does not show the guidance even with 0 orgs when control is disconnected (avoids confusion with a connection issue)", () => {
    renderView({ cockpitTerminals: [], orgs: [], connected: false });
    expect(screen.queryByText("~/.zashiki/repos.conf")).toBeNull();
  });
});

describe("CockpitTerminalListView: session rows", () => {
  it("displays the state icon (Material Symbols) with a state class", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          state: "waiting_input",
        } as CockpitTerminalInfo,
        { ...cockpitTerminals[1], state: "running" } as CockpitTerminalInfo,
        {
          ...cockpitTerminals[2],
          state: "no_claude",
          org: "kilo",
        } as CockpitTerminalInfo,
      ],
    });
    const waiting = screen.getByText("add_alert");
    expect(waiting.className).toContain("state-waiting_input");
    expect(waiting.className).toContain("material-symbols-outlined");
    const running = screen.getByText("progress_activity");
    expect(running.className).toContain("state-running");
    const none = screen.getByText("terminal_2");
    expect(none.className).toContain("state-no_claude");
  });

  it("displays the eye icon with a state class while watching (open tasks, not completed)", () => {
    renderView({
      cockpitTerminals: [
        { ...cockpitTerminals[0], state: "watching" } as CockpitTerminalInfo,
      ],
    });
    const watching = screen.getByText("visibility");
    expect(watching.className).toContain("state-watching");
    expect(watching.className).toContain("material-symbols-outlined");
    expect(screen.queryByText("check")).toBeNull();
  });

  it("displays the pending icon with a state class while starting", () => {
    renderView({
      cockpitTerminals: [
        { ...cockpitTerminals[0], state: "starting" } as CockpitTerminalInfo,
      ],
    });
    const starting = screen.getByText("pending");
    expect(starting.className).toContain("state-starting");
    expect(starting.className).toContain("material-symbols-outlined");
  });

  it("keeps the state glyph clean and puts the subagent on a robot_2 activity chip", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[1],
          state: "running_bg_agent",
          runningSubagents: 1,
        } as CockpitTerminalInfo,
      ],
    });
    const base = screen.getByText("progress_activity");
    expect(base.className).toContain("state-running_bg_agent");
    const glyph = screen.getByText("robot_2");
    expect(glyph.parentElement?.className).toContain("session-activity-agent");
    expect(glyph.className).not.toContain("state-bg-agent-badge");
  });

  it("appends the running subagent total to the agent chip", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[1],
          state: "running_bg_agent",
          runningSubagents: 13,
        } as CockpitTerminalInfo,
      ],
    });
    const chip = screen.getByText("robot_2").parentElement;
    expect(chip?.className).toContain("session-activity-agent");
    expect(chip?.textContent).toContain("13");
  });

  it("shows the agent chip whenever a subagent runs, even when the main state is running", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          state: "running",
          runningSubagents: 5,
        } as CockpitTerminalInfo,
      ],
    });
    const chip = screen.getByText("robot_2").parentElement;
    expect(chip?.className).toContain("session-activity-agent");
    expect(chip?.textContent).toContain("5");
  });

  it("shows no agent chip when the subagent count is 0/unknown", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[1],
          state: "running_bg_agent",
          runningSubagents: 0,
        } as CockpitTerminalInfo,
      ],
    });
    expect(screen.queryByText("robot_2")).toBeNull();
  });

  it("shows a terminal activity chip with the count for a bg shell in any state", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          state: "running",
          shellsRunning: 3,
        } as CockpitTerminalInfo,
      ],
    });
    const chip = screen.getByText("terminal").parentElement;
    expect(chip?.className).toContain("session-activity-shell");
    expect(chip?.textContent).toContain("3");
  });

  it("keeps an idle row's own glyph while a bg shell runs (no running-glyph swap)", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          state: "idle",
          shellsRunning: 1,
        } as CockpitTerminalInfo,
      ],
    });
    expect(screen.getByText("check").className).toContain("state-idle");
    expect(screen.getByText("terminal").parentElement?.className).toContain(
      "session-activity-shell",
    );
    expect(screen.queryByText("progress_activity")).toBeNull();
  });

  it("shows the agent and shell chips together while a subagent and a shell run concurrently", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          state: "running_bg_agent",
          runningSubagents: 9,
          shellsRunning: 3,
        } as CockpitTerminalInfo,
      ],
    });
    const agentChip = screen.getByText("robot_2").parentElement;
    const shellChip = screen.getByText("terminal").parentElement;
    expect(agentChip?.className).toContain("session-activity-agent");
    expect(agentChip?.textContent).toContain("9");
    expect(shellChip?.className).toContain("session-activity-shell");
    expect(shellChip?.textContent).toContain("3");
  });

  it("shows no shell chip when shellsRunning is 0/undefined", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          state: "running",
          shellsRunning: 0,
        } as CockpitTerminalInfo,
        { ...cockpitTerminals[1] } as CockpitTerminalInfo,
      ],
    });
    expect(screen.queryByText("terminal")).toBeNull();
  });

  it("overlays an error badge at the top-right for a row that hit the usage limit", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          state: "running",
          limited: true,
        } as CockpitTerminalInfo,
      ],
    });
    const badge = screen.getByText("error");
    expect(badge.className).toContain("state-limited-badge");
    expect(badge.className).toContain("material-symbols-outlined");
  });

  it("does not show the limit badge when limited is false/undefined", () => {
    renderView({
      cockpitTerminals: [
        {
          ...cockpitTerminals[0],
          state: "running",
          limited: false,
        } as CockpitTerminalInfo,
        { ...cockpitTerminals[1] } as CockpitTerminalInfo,
      ],
    });
    expect(screen.queryByText("error")).toBeNull();
  });

  it("displays idle with conversation history using check", () => {
    renderView({
      cockpitTerminals: [
        { ...cockpitTerminals[1], title: "調査タスク" } as CockpitTerminalInfo,
      ],
    });
    expect(screen.getByText("check").className).toContain("state-idle");
  });

  it("distinguishes a new/unused session (idle with no title) using start", () => {
    // tango is idle with title:null (zero conversation history)
    renderView({
      cockpitTerminals: [cockpitTerminals[1] as CockpitTerminalInfo],
    });
    const fresh = screen.getByText("start");
    expect(fresh.className).toContain("state-fresh");
    expect(screen.queryByText("check")).toBeNull();
  });

  it("shows the summary title in the row and does not visibly show the redundant org name (name)", () => {
    renderView();
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
    renderView();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    expect(row.getAttribute("aria-label")).toBe("tango");
  });

  it("falls back to the window name in the row body until the title is resolved (e.g. right after resume)", () => {
    // tango is title:null; the visible label should show the window name (= org name for
    // owned cockpit terminals), matching the tab, instead of a blank row.
    renderView({
      cockpitTerminals: [cockpitTerminals[1] as CockpitTerminalInfo],
    });
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    expect(row.querySelector(".session-title")?.textContent).toContain("tango");
  });

  it("replaces the window-name fallback with the summary once the title resolves", () => {
    renderView({
      cockpitTerminals: [
        { ...cockpitTerminals[1], title: "調査タスク" } as CockpitTerminalInfo,
      ],
    });
    const row = screen.getByRole("button", {
      name: /tango 調査タスク/,
    });
    const body = row.querySelector(".session-title")?.textContent;
    expect(body).toContain("調査タスク");
    expect(body).not.toContain("tango");
  });

  it("does not highlight unselected rows (only the selected row stands out)", () => {
    renderView({ selectedCockpitTerminalId: SID1 });
    const unselected = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    expect(unselected.getAttribute("aria-current")).toBeNull();
    expect(unselected.textContent).not.toContain(">");
  });

  it("exposes the org color as a CSS var on each row (for the selected-row left bar)", () => {
    renderView();
    const row = screen.getByRole("button", { name: /zashiki(?! を閉じる)/ });
    expect(row.style.getPropertyValue("--org-color")).not.toBe("");
  });

  it("marks the selected row with aria-current so it gets the strong highlight", () => {
    renderView({ selectedCockpitTerminalId: SID1 });
    const row = screen.getByRole("button", { name: /zashiki(?! を閉じる)/ });
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("calls onSelect(cockpitTerminalId) on double-click", () => {
    const props = renderView();
    fireEvent.doubleClick(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    expect(props.onSelect).toHaveBeenCalledWith(SID2);
  });

  it("does not expand on a single click (does not call onSelect); only applies the focus ring", () => {
    const props = renderView();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(row.className).toContain("session-row-focused");
  });

  it("a single click on the selected row is a no-op (does not move the focus ring either)", () => {
    const props = renderView({ selectedCockpitTerminalId: SID2 });
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(row.className).not.toContain("session-row-focused");
  });

  it("does not expand on two consecutive single clicks on the same row (not treated as a double-click); core of misfire prevention", () => {
    const props = renderView();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    fireEvent.click(row);
    fireEvent.click(row);
    // Two single clicks (no synthesized dblclick) must not expand = prohibit regressing to a two-step interaction
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("a double-click on the currently shown (selected) row does not resend onSelect (idempotency guard)", () => {
    const props = renderView({ selectedCockpitTerminalId: SID2 });
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    fireEvent.doubleClick(row);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("shows a discoverability title on the row button (double-click/Enter)", () => {
    renderView();
    const row = screen.getByRole("button", {
      name: /tango(?! を閉じる)/,
    });
    expect(row.getAttribute("title")).toContain("ダブルクリック");
  });

  it("collapses the focus ring after expanding on double-click (delegates to the selection highlight)", () => {
    renderView();
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
    renderView({ selectedCockpitTerminalId: SID2 });
    expect(
      screen
        .getByRole("button", { name: /tango(?! を閉じる)/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });
});

describe("CockpitTerminalListView: applying manual titles", () => {
  it("visibly shows the manual title from conversationTitles in the row (immediate reflection of header rename)", () => {
    renderView({
      conversationTitles: {
        [SID2]: { title: "デプロイ調査", name: "tango" },
      },
    });
    expect(screen.getByText("デプロイ調査")).toBeTruthy();
  });

  it("prefers the manual title over the automatic title", () => {
    renderView({
      conversationTitles: {
        [SID1]: { title: "手で付けた名前", name: "zashiki" },
      },
    });
    expect(screen.getByText("手で付けた名前")).toBeTruthy();
    expect(screen.queryByText("issue #5 を実装して")).toBeNull();
  });

  it("reflects the manual title in the aria-label too", () => {
    renderView({
      conversationTitles: {
        [SID1]: { title: "手で付けた名前", name: "zashiki" },
      },
    });
    const row = screen.getByRole("button", { name: /手で付けた名前/ });
    expect(row.getAttribute("aria-label")).toBe("zashiki 手で付けた名前");
  });

  it("does not apply a manual title whose saved name does not match the current session (a safeguard for sid collisions and duplicate resumes)", () => {
    renderView({
      conversationTitles: {
        [SID1]: { title: "別リポの名残", name: "other-repo" },
      },
    });
    expect(screen.queryByText("別リポの名残")).toBeNull();
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
  });

  it("removes the fresh (start) treatment when a manual title is given to a fresh session (idle, no title)", () => {
    // tango is idle with title:null (originally fresh = start icon)
    renderView({
      conversationTitles: {
        [SID2]: { title: "新しい調査", name: "tango" },
      },
    });
    expect(screen.getByText("新しい調査")).toBeTruthy();
    expect(screen.queryByText("start")).toBeNull();
    expect(screen.getByText("check").className).toContain("state-idle");
  });
});

describe("CockpitTerminalListView: focusing the terminal on double-click/Enter", () => {
  const view = () => screen.getByRole("complementary");
  const rowFor = (name: string) =>
    screen.getByRole("button", {
      name: new RegExp(`${name}(?! を閉じる)`),
    }) as HTMLElement;

  it("calls onSelect and onFocusTerminal on double-clicking a different session", () => {
    const props = renderView();
    fireEvent.doubleClick(rowFor("tango"));
    expect(props.onSelect).toHaveBeenCalledWith(SID2);
    expect(props.onFocusTerminal).toHaveBeenCalled();
  });

  it("does not resend onSelect on double-clicking the shown session but still calls onFocusTerminal", () => {
    const props = renderView({ selectedCockpitTerminalId: SID2 });
    fireEvent.doubleClick(rowFor("tango"));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onFocusTerminal).toHaveBeenCalled();
  });

  it("calls onFocusTerminal when opening the focused row with Enter too", () => {
    const props = renderView();
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @1
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @2
    fireEvent.keyDown(view(), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith(SID2);
    expect(props.onFocusTerminal).toHaveBeenCalled();
  });
});

describe("CockpitTerminalListView: right-click menu", () => {
  it("always shows a visible + new button on each org header (including empty orgs)", () => {
    renderView();
    expect(
      screen.getByRole("button", { name: "kilo に新規セッション" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "charlie に新規セッション" }),
    ).toBeTruthy();
    // Show + on an org with 0 cockpit terminals (delta) too (that's exactly where the new-session entry point is needed)
    expect(
      screen.getByRole("button", { name: "delta に新規セッション" }),
    ).toBeTruthy();
  });

  it("calls onNew(org) for that org on clicking the + on the org header", () => {
    const props = renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "charlie に新規セッション" }),
    );
    expect(props.onNew).toHaveBeenCalledWith("charlie");
  });

  it("clicking the + on the org header does not propagate to the collapse toggle (does not change the collapse state)", () => {
    renderView();
    // Precondition: kilo is expanded and its session rows are visible
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "kilo に新規セッション" }),
    );
    // Stays expanded after pressing + (not accidentally collapsed)
    expect(screen.getByText("kilo (2)")).toBeTruthy();
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
  });

  it("clicking the + on the org header does not trigger row selection (onSelect)", () => {
    const props = renderView();
    fireEvent.click(
      screen.getByRole("button", { name: "kilo に新規セッション" }),
    );
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("shows a ✕ button at the right end of each row", () => {
    renderView();
    expect(screen.getByRole("button", { name: "tango を閉じる" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "zashiki を閉じる" }),
    ).toBeTruthy();
  });

  it("calls onClose(cockpitTerminalId) immediately on clicking the row ✕ without a confirmation", () => {
    const props = renderView();
    fireEvent.click(screen.getByRole("button", { name: "tango を閉じる" }));
    expect(props.onClose).toHaveBeenCalledWith(SID2);
    // Does not show the confirmation bar (same behavior as right-click Delete)
    expect(
      screen.queryByRole("button", { name: "tango を閉じる（確定）" }),
    ).toBeNull();
  });

  it("clicking the row ✕ does not trigger row selection (onSelect)", () => {
    const props = renderView();
    fireEvent.click(screen.getByRole("button", { name: "tango を閉じる" }));
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("wires each row's ✕ to its own row's cockpitTerminalId (no misconnection to another row)", () => {
    const props = renderView();
    fireEvent.click(screen.getByRole("button", { name: "zashiki を閉じる" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledWith(SID1);
  });

  it("right-clicking the org header and choosing 'New session' calls onNew(org)", () => {
    const props = renderView();
    fireEvent.contextMenu(screen.getByText("charlie (1)"));
    fireEvent.click(screen.getByRole("menuitem", { name: "新規セッション" }));
    expect(props.onNew).toHaveBeenCalledWith("charlie");
  });

  it("shows 'Delete' but not 'New session' in the row right-click menu", () => {
    renderView();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    expect(screen.getByRole("menuitem", { name: "削除" })).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "新規セッション" }),
    ).toBeNull();
  });

  it("right-clicking the row and choosing 'Delete' calls onClose(cockpitTerminalId) immediately without a confirmation", () => {
    const props = renderView();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(props.onClose).toHaveBeenCalledWith(SID2);
    // Does not show the confirmation bar
    expect(
      screen.queryByRole("button", { name: "tango を閉じる（確定）" }),
    ).toBeNull();
  });

  it("closes the menu after choosing Delete", () => {
    renderView();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("closes the menu after choosing a menu item", () => {
    renderView();
    fireEvent.contextMenu(screen.getByText("charlie (1)"));
    fireEvent.click(screen.getByRole("menuitem", { name: "新規セッション" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("closes the menu on a background click", () => {
    renderView();
    fireEvent.contextMenu(screen.getByText("charlie (1)"));
    expect(
      screen.getByRole("menuitem", { name: "新規セッション" }),
    ).toBeTruthy();
    const backdrop = document.querySelector(".session-context-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("right-clicking a row with a sid and choosing 'Duplicate session' calls onDuplicate(cockpitTerminalId)", () => {
    const withSid: CockpitTerminalInfo[] = [
      { ...cockpitTerminals[1], sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f" },
    ] as CockpitTerminalInfo[];
    const props = renderView({
      cockpitTerminals: withSid,
      onDuplicate: vi.fn(),
    });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    const item = screen.getByRole("menuitem", {
      name: "セッションを複製",
    });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item);
    expect(props.onDuplicate).toHaveBeenCalledWith(SID2);
    // The menu closes after selection
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("disables 'Duplicate session' for a row without a sid", () => {
    const noSid: CockpitTerminalInfo[] = [
      { ...cockpitTerminals[1], sid: undefined },
    ] as CockpitTerminalInfo[];
    renderView({ cockpitTerminals: noSid, onDuplicate: vi.fn() });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    const item = screen.getByRole("menuitem", {
      name: "セッションを複製",
    });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not show the duplicate item when onDuplicate is not provided (backward compatibility)", () => {
    renderView();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "セッションを複製" }),
    ).toBeNull();
    expect(screen.getByRole("menuitem", { name: "削除" })).toBeTruthy();
  });

  it("right-clicking a row with a sid and choosing 'Copy Claude Code session ID' calls onCopySessionId(cockpitTerminalId)", () => {
    const props = renderView({ onCopySessionId: vi.fn() });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    const item = screen.getByRole("menuitem", {
      name: "Claude Code セッションIDをコピー",
    });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item);
    expect(props.onCopySessionId).toHaveBeenCalledWith(SID2);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("disables 'Copy Claude Code session ID' for a row without a sid", () => {
    const noSid: CockpitTerminalInfo[] = [
      { ...cockpitTerminals[1], sid: undefined },
    ] as CockpitTerminalInfo[];
    renderView({ cockpitTerminals: noSid, onCopySessionId: vi.fn() });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    const item = screen.getByRole("menuitem", {
      name: "Claude Code セッションIDをコピー",
    });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not show the copy-session-id item when onCopySessionId is not provided (backward compatibility)", () => {
    renderView();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /tango(?! を閉じる)/ }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: "Claude Code セッションIDをコピー",
      }),
    ).toBeNull();
  });

  it("clears the confirmation state when the target session disappears while the confirmation bar (Ctrl-X) is shown", () => {
    const props = {
      cockpitTerminals,
      orgs,
      selectedCockpitTerminalId: SID2 as string | null,
      onSelect: vi.fn(),
      onNew: vi.fn(),
      onClose: vi.fn(),
      onSave: vi.fn(),
      onRestore: vi.fn(),
    };
    const { rerender } = render(<CockpitTerminalListView {...props} />);
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "x",
      ctrlKey: true,
    });
    expect(
      screen.getByRole("button", { name: "tango を閉じる（確定）" }),
    ).toBeTruthy();
    // @2 disappears -> the confirmation state is also cleared, and the confirmation bar isn't re-shown even if @2 returns
    const without = cockpitTerminals.filter(
      (s) => s.cockpitTerminalId !== SID2,
    );
    rerender(<CockpitTerminalListView {...props} cockpitTerminals={without} />);
    rerender(
      <CockpitTerminalListView
        {...props}
        cockpitTerminals={cockpitTerminals}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "tango を閉じる（確定）" }),
    ).toBeNull();
  });
});

describe("CockpitTerminalListView: operations", () => {
  it("Ctrl-N calls onNew with the selected session's org", () => {
    const props = renderView({ selectedCockpitTerminalId: SID3 });
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "n",
      ctrlKey: true,
    });
    expect(props.onNew).toHaveBeenCalledWith("charlie");
  });

  it("Ctrl-N calls onNew with the first org when nothing is selected", () => {
    const props = renderView();
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "n",
      ctrlKey: true,
    });
    expect(props.onNew).toHaveBeenCalledWith("kilo");
  });

  it("Ctrl-X opens the inline confirmation for the selected session and closes it on confirm", () => {
    const props = renderView({ selectedCockpitTerminalId: SID2 });
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "x",
      ctrlKey: true,
    });
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "tango を閉じる（確定）" }),
    );
    expect(props.onClose).toHaveBeenCalledWith(SID2);
  });

  it("Ctrl-X does nothing when nothing is selected", () => {
    const props = renderView();
    fireEvent.keyDown(screen.getByRole("complementary"), {
      key: "x",
      ctrlKey: true,
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("CockpitTerminalListView: arrow-key navigation (flattened)", () => {
  const view = () => screen.getByRole("complementary");
  const rowFor = (name: string) =>
    screen.getByRole("button", {
      name: new RegExp(`${name}(?! を閉じる)`),
    }) as HTMLElement;
  const orgHeader = (label: string) =>
    screen.getByRole("button", { name: label }) as HTMLElement;

  it("the first ↓ move puts the focus ring on the first org header (does not switch the terminal)", () => {
    const props = renderView();
    fireEvent.keyDown(view(), { key: "ArrowDown" });
    expect(orgHeader("kilo (2)").className).toContain("session-org-focused");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("↓ moves flatly and continuously across org headers and their rows (org→@1→@2→org(charlie)→@3)", () => {
    renderView();
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // org kilo
    expect(orgHeader("kilo (2)").className).toContain("session-org-focused");
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @1
    expect(rowFor("zashiki").className).toContain("session-row-focused");
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @2
    expect(rowFor("tango").className).toContain("session-row-focused");
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // org charlie
    expect(orgHeader("charlie (1)").className).toContain("session-org-focused");
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @3
    expect(rowFor("charlie-app").className).toContain("session-row-focused");
  });

  it("calls onSelect on Enter while a session row is focused", () => {
    const props = renderView();
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @1
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @2
    fireEvent.keyDown(view(), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith(SID2);
  });

  it("toggles the collapse on Enter while an org header is focused (does not call onSelect)", () => {
    const props = renderView();
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(view(), { key: "Enter" }); // collapse
    expect(orgHeader("kilo (2)").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("issue #5 を実装して")).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("expands a collapsed org header on Enter while it is focused", () => {
    renderView();
    fireEvent.click(screen.getByText("kilo (2)")); // collapse (clicking also moves focused to the org)
    expect(screen.queryByText("issue #5 を実装して")).toBeNull();
    fireEvent.keyDown(view(), { key: "Enter" }); // expand the already-focused org
    expect(screen.getByText("issue #5 を実装して")).toBeTruthy();
  });

  it("puts the focus ring (session-org-focused) on clicking the org header", () => {
    renderView();
    fireEvent.click(screen.getByText("charlie (1)")); // collapse + focus ring
    expect(orgHeader("charlie (1)").className).toContain("session-org-focused");
  });

  it("does not toggle on the aside side for an Enter arriving directly on the org header button (delegated to the native click to prevent a double toggle)", () => {
    renderView();
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // focused=org kilo (expanded)
    // Simulate the real DOM focus being on the org button, and send Enter with the button as target.
    // If the aside handles it, it opens together with the native click and immediately closes, so the aside skips it.
    fireEvent.keyDown(orgHeader("kilo (2)"), { key: "Enter" });
    // The aside doesn't perform the collapse (delegated to the native button click path) = stays expanded.
    expect(orgHeader("kilo (2)").getAttribute("aria-expanded")).toBe("true");
  });

  it("adds aria-expanded (expansion state) to the org header", () => {
    renderView();
    expect(orgHeader("kilo (2)").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByText("kilo (2)"));
    expect(orgHeader("kilo (2)").getAttribute("aria-expanded")).toBe("false");
  });

  it("anchors ↑↓ at the selected row when no focus is set (moves to the row after the selected one)", () => {
    renderView({ selectedCockpitTerminalId: SID2 });
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // next after @2 = org charlie
    expect(orgHeader("charlie (1)").className).toContain("session-org-focused");
  });

  it("anchors ↑↓ at the org header when the selected row is inside a collapsed org with no focus (does not jump to the list edge)", () => {
    renderView({ selectedCockpitTerminalId: SID2 });
    fireEvent.click(screen.getByText("kilo (2)")); // collapse @2's org (focused=org kilo)
    fireEvent.doubleClick(rowFor("charlie-app")); // select(@3): reset focused=null (the selected prop stays @2)
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // anchor=org kilo -> next org charlie
    expect(orgHeader("charlie (1)").className).toContain("session-org-focused");
  });

  it("↑ at the top stays at the top (the first org header); clamps at the edge", () => {
    renderView();
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(view(), { key: "ArrowUp" }); // stays at the top
    expect(orgHeader("kilo (2)").className).toContain("session-org-focused");
  });

  it("excludes rows under a collapsed org from focus movement (the header remains)", () => {
    renderView();
    fireEvent.click(screen.getByText("kilo (2)")); // collapse @1/@2, focused=org kilo
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // skip the child rows to the next org charlie
    expect(orgHeader("charlie (1)").className).toContain("session-org-focused");
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @3
    expect(rowFor("charlie-app").className).toContain("session-row-focused");
  });

  it("Enter does nothing when nothing is focused", () => {
    const props = renderView();
    fireEvent.keyDown(view(), { key: "Enter" });
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("does not select the focused row on Enter after collapsing its org (misfire prevention)", () => {
    const props = renderView();
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @1
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @2
    fireEvent.click(screen.getByText("kilo (2)")); // collapse -> @2 invisible, focused moves to the org
    fireEvent.keyDown(view(), { key: "Enter" }); // expands the org, not selects @2
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("does not select on the IME composition-confirming Enter (isComposing)", () => {
    const props = renderView();
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // org kilo
    fireEvent.keyDown(view(), { key: "ArrowDown" }); // @1 row
    fireEvent.keyDown(view(), { key: "Enter", isComposing: true });
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});

describe("CockpitTerminalListView: header", () => {
  it("labels the header SESSION LIST (no save/restore buttons; already automated)", () => {
    renderView();
    expect(screen.getByText("SESSION LIST")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "セッションを保存" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "セッションを復元" }),
    ).toBeNull();
  });
});

describe("CockpitTerminalListView: empty state", () => {
  it("does not show an empty state in the list even with 0 cockpitTerminals (moved to the main area)", () => {
    renderView({ cockpitTerminals: [], orgs: ["kilo"] });
    expect(screen.queryByText("セッションがありません")).toBeNull();
    // Show org headers (the right-click entry point for new cockpit terminals) as before
    expect(screen.getByText("kilo (0)")).toBeTruthy();
  });
});

describe("CockpitTerminalListView: add-org header button", () => {
  it("renders the plus button only when onAddOrg is given and calls it on click", () => {
    const onAddOrg = vi.fn();
    renderView({ onAddOrg });
    const btn = screen.getByRole("button", { name: "組織を追加" });
    fireEvent.click(btn);
    expect(onAddOrg).toHaveBeenCalled();
  });

  it("hides the plus button when onAddOrg is omitted", () => {
    renderView();
    expect(screen.queryByRole("button", { name: "組織を追加" })).toBeNull();
  });
});

describe("CockpitTerminalListView: Rename", () => {
  const rowFor = (name: string) =>
    screen.getByRole("button", {
      name: new RegExp(`${name}(?! を閉じる)`),
    }) as HTMLElement;
  const renameInput = () =>
    screen.getByRole("textbox", {
      name: "セッションのタイトルを編集",
    }) as HTMLInputElement;

  it("shows 'Rename' in the row right-click menu when onRename is provided", () => {
    renderView({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    expect(screen.getByRole("menuitem", { name: "名前を変更" })).toBeTruthy();
  });

  it("does not show 'Rename' when onRename is not provided (backward compatibility)", () => {
    renderView();
    fireEvent.contextMenu(rowFor("tango"));
    expect(screen.queryByRole("menuitem", { name: "名前を変更" })).toBeNull();
  });

  it("choosing 'Rename' shows an input prefilled with the current title, and Enter after changing the value calls onRename(cockpitTerminalId, name, value)", () => {
    const props = renderView({ onRename: vi.fn() });
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
    const props = renderView({
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
    renderView({
      onRename: vi.fn(),
      cockpitTerminals: [
        { ...cockpitTerminals[1], title: null } as CockpitTerminalInfo,
      ],
    });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    expect(renameInput().value).toBe("tango");
  });

  it("cancels on Escape (does not call onRename; the input disappears)", () => {
    const props = renderView({ onRename: vi.fn() });
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
    const props = renderView({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    fireEvent.change(renameInput(), { target: { value: "確定名" } });
    fireEvent.blur(renameInput());
    expect(props.onRename).toHaveBeenCalledWith(SID2, "tango", "確定名");
  });

  it("closes the menu after choosing 'Rename'", () => {
    renderView({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("disables 'Rename' for a non-UUID window (unbound/plain-shell)", () => {
    renderView({
      onRename: vi.fn(),
      cockpitTerminals: [
        {
          ...cockpitTerminals[1],
          cockpitTerminalId: "shell:0:tango",
        } as CockpitTerminalInfo,
      ],
    });
    fireEvent.contextMenu(rowFor("tango"));
    const item = screen.getByRole("menuitem", { name: "名前を変更" });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps 'Rename' enabled for a UUID window even when claude is not detected (state no_claude, sid absent)", () => {
    const props = renderView({
      onRename: vi.fn(),
      cockpitTerminals: [
        {
          ...cockpitTerminals[1],
          state: "no_claude",
          sid: undefined,
        } as CockpitTerminalInfo,
      ],
    });
    fireEvent.contextMenu(rowFor("tango"));
    const item = screen.getByRole("menuitem", { name: "名前を変更" });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item);
    fireEvent.change(renameInput(), { target: { value: "終了後に改名" } });
    fireEvent.keyDown(renameInput(), { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith(SID2, "tango", "終了後に改名");
  });

  it("does not propagate Enter during editing to row selection (onSelect)", () => {
    const props = renderView({ onRename: vi.fn() });
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    fireEvent.change(renameInput(), { target: { value: "名前" } });
    fireEvent.keyDown(renameInput(), { key: "Enter" });
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("aborts editing when the target session disappears", () => {
    const props = {
      cockpitTerminals,
      orgs,
      selectedCockpitTerminalId: null as string | null,
      onSelect: vi.fn(),
      onNew: vi.fn(),
      onClose: vi.fn(),
      onRename: vi.fn(),
    };
    const { rerender } = render(<CockpitTerminalListView {...props} />);
    fireEvent.contextMenu(rowFor("tango"));
    fireEvent.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    expect(
      screen.getByRole("textbox", { name: "セッションのタイトルを編集" }),
    ).toBeTruthy();
    const without = cockpitTerminals.filter(
      (s) => s.cockpitTerminalId !== SID2,
    );
    rerender(<CockpitTerminalListView {...props} cockpitTerminals={without} />);
    expect(
      screen.queryByRole("textbox", { name: "セッションのタイトルを編集" }),
    ).toBeNull();
    expect(props.onRename).not.toHaveBeenCalled();
  });
});

describe("CockpitTerminalListView: org reorder via drag-and-drop", () => {
  it("persists the new order and reflects it optimistically when an org header is dropped onto another", () => {
    const onReorderOrgs = vi.fn();
    renderView({ onReorderOrgs });
    const kiloHeader = screen
      .getByText("kilo (2)")
      .closest(".session-org-header") as HTMLElement;
    const deltaSection = screen
      .getByText("delta (0)")
      .closest(".session-org") as HTMLElement;
    fireEvent.dragStart(kiloHeader);
    fireEvent.dragOver(deltaSection);
    // The hovered drop target shows the insertion indicator.
    expect(deltaSection.classList.contains("session-org-drop")).toBe(true);
    fireEvent.drop(deltaSection);
    expect(onReorderOrgs).toHaveBeenCalledWith(["charlie", "kilo", "delta"]);
    // The list moves immediately (optimistic), without waiting for a state.sync round-trip.
    const labels = Array.from(
      document.querySelectorAll(".session-org-label"),
    ).map((e) => e.textContent);
    expect(labels).toEqual(["charlie (1)", "kilo (2)", "delta (0)"]);
  });

  it("does not make headers draggable when onReorderOrgs is omitted", () => {
    renderView();
    const kiloHeader = screen
      .getByText("kilo (2)")
      .closest(".session-org-header") as HTMLElement;
    expect(kiloHeader.getAttribute("draggable")).toBe("false");
  });
});
