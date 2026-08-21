// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CockpitTerminalInfo } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Tab } from "../tabs/tab-model.js";
import { TabBar } from "./TabBar.js";

const SID = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
const SID2 = "11111111-2222-4333-8444-555566667777";
const KEY = `session:${SID}`;
const KEY2 = `session:${SID2}`;

const session: CockpitTerminalInfo = {
  cockpitTerminalId: SID,
  name: "myrepo",
  org: "o",
  repo: "myrepo",
  state: "idle",
  title: "最初のプロンプト",
  sid: SID,
  active: true,
};

const s = (id: string): Tab => ({ kind: "session", id });

afterEach(cleanup);

describe("TabBar", () => {
  it("renders nothing when there are no tabs (the empty state is the caller's responsibility)", () => {
    const { container } = render(
      <TabBar
        tabs={[]}
        activeKey={null}
        cockpitTerminals={[]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the title for a session tab via resolveTitle", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("最初のプロンプト")).toBeTruthy();
  });

  it("resolves manually edited titles for all tabs", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{ [SID]: { title: "手動名", name: "myrepo" } }}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("手動名")).toBeTruthy();
  });

  it("shows the full text on hover via the title attribute even when truncated by tab width", () => {
    const longTitle =
      "とても長いセッションタイトルなのでタブ幅では省略されるはず";
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[{ ...session, title: longTitle }]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("tab").getAttribute("title")).toBe(longTitle);
  });

  it("keeps the full path in title for a viewer tab", () => {
    const rel = "very/deeply/nested/path/to/some-long-file-name.md";
    const e = (id: string): Tab => ({ kind: "viewer", id });
    render(
      <TabBar
        tabs={[e(`/repo\n${rel}`)]}
        activeKey={`viewer:/repo\n${rel}`}
        cockpitTerminals={[]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("tab").getAttribute("title")).toBe(rel);
  });

  it("adds aria-selected to the active tab", () => {
    render(
      <TabBar
        tabs={[s(SID), s(SID2)]}
        activeKey={KEY2}
        cockpitTerminals={[
          session,
          { ...session, cockpitTerminalId: SID2, title: "二番目" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain(
      "二番目",
    );
  });

  it("calls onActivate(key) on clicking the tab body", () => {
    const onActivate = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={null}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={onActivate}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab"));
    expect(onActivate).toHaveBeenCalledWith(KEY);
  });

  it("calls onClose(key) on ✕ click without calling onActivate (propagation stopped)", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={onActivate}
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "最初のプロンプト のタブを閉じる" }),
    );
    expect(onClose).toHaveBeenCalledWith(KEY);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("falls back to the id as the label when the session is not in the list", () => {
    render(
      <TabBar
        tabs={[s("@9")]}
        activeKey="session:@9"
        cockpitTerminals={[]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("@9")).toBeTruthy();
  });

  it("gives a session tab an org-color dot (the org name is confirmable via title)", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[{ ...session, org: "whiskey" }]}
        conversationTitles={{}}
        orgColors={{ whiskey: "#123456" }}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const dot = screen.getByTitle("whiskey");
    expect(dot.className).toContain("tab-org-dot");
    expect((dot as HTMLElement).style.backgroundColor).toBe("rgb(18, 52, 86)");
  });

  it("colors the top border of an active session tab with the org color too", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[{ ...session, org: "whiskey" }]}
        conversationTitles={{}}
        orgColors={{ whiskey: "#123456" }}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const tab = screen.getByTitle("whiskey").closest(".tab") as HTMLElement;
    expect(tab.style.borderTopColor).toBe("rgb(18, 52, 86)");
  });

  it("does not apply a top border color to an inactive session tab", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={null}
        cockpitTerminals={[{ ...session, org: "whiskey" }]}
        conversationTitles={{}}
        orgColors={{ whiskey: "#123456" }}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const tab = screen.getByTitle("whiskey").closest(".tab") as HTMLElement;
    expect(tab.style.borderTopColor).toBe("");
  });

  it("enters rename editing on double-click and calls onRename(cockpitTerminalId, name, value) on Enter", () => {
    const onRename = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "新しい名前" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(SID, "myrepo", "新しい名前");
  });

  it("does not allow rename for a non-UUID window (unbound/plain-shell)", () => {
    const onRename = vi.fn();
    render(
      <TabBar
        tabs={[s("shell:0:myrepo")]}
        activeKey="session:shell:0:myrepo"
        cockpitTerminals={[{ ...session, cockpitTerminalId: "shell:0:myrepo" }]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("allows rename for a UUID window even when claude is not detected (state no_claude, sid absent)", () => {
    const onRename = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[{ ...session, state: "no_claude", sid: undefined }]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "終了後に改名" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(SID, "myrepo", "終了後に改名");
  });

  it("cancels on Escape during rename editing without calling onRename", () => {
    const onRename = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "捨てる" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("commits the rename on blur as well", () => {
    const onRename = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "blur 確定" } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith(SID, "myrepo", "blur 確定");
  });

  it("does not commit the rename on the IME composition-confirming Enter (isComposing)", () => {
    const onRename = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "へんかん" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(SID, "myrepo", "へんかん");
  });

  it("does not commit the rename when blur follows an Escape cancel (does not save a discarded draft)", () => {
    const onRename = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "捨てる" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("does not spuriously commit when the tab is pruned away during editing (does not call rename)", () => {
    const onRename = vi.fn();
    const { rerender } = render(
      <TabBar
        tabs={[s(SID), s(SID2)]}
        activeKey={KEY}
        cockpitTerminals={[
          session,
          { ...session, cockpitTerminalId: SID2, sid: SID2, name: "other" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getAllByRole("tab")[0] as HTMLElement);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "@1 のタイトル" },
    });
    // @1 disappears on another client (prune) -> even if the input's unmount blur runs, it must not mistakenly commit
    rerender(
      <TabBar
        tabs={[s(SID2)]}
        activeKey={KEY2}
        cockpitTerminals={[
          { ...session, cockpitTerminalId: SID2, sid: SID2, name: "other" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("calls onReorder(from, to) when dragging a tab and dropping it on another tab", () => {
    const onReorder = vi.fn();
    render(
      <TabBar
        tabs={[s(SID), s(SID2)]}
        activeKey={KEY}
        cockpitTerminals={[
          session,
          { ...session, cockpitTerminalId: SID2, title: "二番目" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onReorder={onReorder}
      />,
    );
    const tabEls = screen
      .getAllByRole("tab")
      .map((el) => el.closest(".tab") as HTMLElement);
    const tab1 = tabEls[0] as HTMLElement;
    const tab2 = tabEls[1] as HTMLElement;
    fireEvent.dragStart(tab1);
    fireEvent.dragOver(tab2);
    fireEvent.drop(tab2);
    expect(onReorder).toHaveBeenCalledWith(KEY, KEY2);
  });

  it("suppresses the default on dragEnter/dragOver over another tab to satisfy the drop-target contract (assuming WebKit fires drop)", () => {
    render(
      <TabBar
        tabs={[s(SID), s(SID2)]}
        activeKey={KEY}
        cockpitTerminals={[
          session,
          { ...session, cockpitTerminalId: SID2, title: "二番目" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onReorder={() => undefined}
      />,
    );
    const tabEls = screen
      .getAllByRole("tab")
      .map((el) => el.closest(".tab") as HTMLElement);
    const tab1 = tabEls[0] as HTMLElement;
    const tab2 = tabEls[1] as HTMLElement;
    fireEvent.dragStart(tab1);
    // fireEvent returns false if preventDefault was called. WebKit won't fire drop
    // unless both dragenter/dragover are suppressed (Apple Safari DnD guide).
    expect(fireEvent.dragEnter(tab2)).toBe(false);
    expect(fireEvent.dragOver(tab2)).toBe(false);
    expect(tab2.className).toContain("tab-drag-over");
  });

  it("does not call onReorder when dropping on the same tab", () => {
    const onReorder = vi.fn();
    render(
      <TabBar
        tabs={[s(SID), s(SID2)]}
        activeKey={KEY}
        cockpitTerminals={[
          session,
          { ...session, cockpitTerminalId: SID2, title: "二番目" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onReorder={onReorder}
      />,
    );
    const tab1 = screen.getAllByRole("tab")[0]?.closest(".tab") as HTMLElement;
    fireEvent.dragStart(tab1);
    fireEvent.drop(tab1);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("does not call onReorder on a drop without a drag start (equivalent to an external drag)", () => {
    const onReorder = vi.fn();
    render(
      <TabBar
        tabs={[s(SID), s(SID2)]}
        activeKey={KEY}
        cockpitTerminals={[
          session,
          { ...session, cockpitTerminalId: SID2, title: "二番目" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onReorder={onReorder}
      />,
    );
    const tab2 = screen.getAllByRole("tab")[1]?.closest(".tab") as HTMLElement;
    fireEvent.drop(tab2);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("does not make tabs draggable when onReorder is not provided (reordering disabled)", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const tab = screen.getByRole("tab").closest(".tab") as HTMLElement;
    expect(tab.getAttribute("draggable")).toBe("false");
  });

  it("keeps editing across a detected-sid change under the same cockpitTerminalId (the title is keyed by the stable cockpitTerminalId, not the transient sid)", () => {
    const onRename = vi.fn();
    const { rerender } = render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "編集中の下書き" },
    });
    // The detected sid changes (e.g. claude restarted) but the cockpitTerminalId is unchanged.
    rerender(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[{ ...session, sid: SID2 }]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );
    const input = screen.queryByRole("textbox") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    fireEvent.keyDown(input as HTMLInputElement, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(SID, "myrepo", "編集中の下書き");
  });

  it("right-clicking a session tab with a sid and choosing 'Duplicate session' calls onDuplicate", () => {
    const onDuplicate = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[
          { ...session, sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onDuplicate={onDuplicate}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    const item = screen.getByRole("menuitem", {
      name: "セッションを複製",
    });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item);
    expect(onDuplicate).toHaveBeenCalledWith(SID);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("disables the duplicate item for a session tab without a sid", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[{ ...session, sid: undefined }]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onDuplicate={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    const item = screen.getByRole("menuitem", {
      name: "セッションを複製",
    });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("right-clicking a session tab with a sid and choosing 'Copy Claude Code session ID' calls onCopySessionId", () => {
    const onCopySessionId = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onCopySessionId={onCopySessionId}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    const item = screen.getByRole("menuitem", {
      name: "Claude Code セッションIDをコピー",
    });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item);
    expect(onCopySessionId).toHaveBeenCalledWith(SID);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("disables the copy-session-id item for a session tab without a sid", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[{ ...session, sid: undefined }]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onCopySessionId={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    const item = screen.getByRole("menuitem", {
      name: "Claude Code セッションIDをコピー",
    });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows close, close all, duplicate and copy items for a session tab when all handlers are provided", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onCloseAll={vi.fn()}
        onDuplicate={vi.fn()}
        onCopySessionId={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(
      [
        "閉じる",
        "全て閉じる",
        "セッションを複製",
        "Claude Code セッションIDをコピー",
      ],
    );
  });

  it("right-clicking a tab and choosing 'Close' calls onClose(key) and closes the menu", () => {
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={onClose}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    fireEvent.click(screen.getByRole("menuitem", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledWith(KEY);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("right-clicking a tab and choosing 'Close all tabs' calls onCloseAll", () => {
    const onCloseAll = vi.fn();
    render(
      <TabBar
        tabs={[s(SID), s(SID2)]}
        activeKey={KEY}
        cockpitTerminals={[
          session,
          { ...session, cockpitTerminalId: SID2, title: "二番目" },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onCloseAll={onCloseAll}
      />,
    );
    fireEvent.contextMenu(
      screen.getByText("二番目").closest(".tab") as Element,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "全て閉じる" }));
    expect(onCloseAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("hides 'Close all tabs' when onCloseAll is not provided but still shows 'Close'", () => {
    render(
      <TabBar
        tabs={[s(SID)]}
        activeKey={KEY}
        cockpitTerminals={[session]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    expect(screen.getByRole("menuitem", { name: "閉じる" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "全て閉じる" })).toBeNull();
  });

  it("shows close / close all on a viewer tab but not the session-only duplicate / copy items", () => {
    const viewerId = "/repo\nsrc/main.ts";
    const e = (id: string): Tab => ({ kind: "viewer", id });
    render(
      <TabBar
        tabs={[e(viewerId)]}
        activeKey={`viewer:${viewerId}`}
        cockpitTerminals={[]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onCloseAll={vi.fn()}
        onDuplicate={vi.fn()}
        onCopySessionId={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(
      ["閉じる", "全て閉じる"],
    );
  });

  it("closes a viewer tab via 'Close' with its composite viewer key", () => {
    const onClose = vi.fn();
    const viewerId = "/repo\nsrc/main.ts";
    const e = (id: string): Tab => ({ kind: "viewer", id });
    render(
      <TabBar
        tabs={[e(viewerId)]}
        activeKey={`viewer:${viewerId}`}
        cockpitTerminals={[]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={onClose}
        onCloseAll={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab"));
    fireEvent.click(screen.getByRole("menuitem", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledWith(`viewer:${viewerId}`);
  });

  it("passes the cockpitTerminalId of the right-clicked window when there are multiple tabs (no mix-up)", () => {
    const onDuplicate = vi.fn();
    render(
      <TabBar
        tabs={[s(SID), s(SID2)]}
        activeKey={KEY}
        cockpitTerminals={[
          { ...session, sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f" },
          {
            ...session,
            cockpitTerminalId: SID2,
            title: "二番目",
            sid: "11111111-2222-3333-4444-555555555555",
          },
        ]}
        conversationTitles={{}}
        onActivate={() => undefined}
        onClose={() => undefined}
        onDuplicate={onDuplicate}
      />,
    );
    fireEvent.contextMenu(
      screen.getByText("二番目").closest(".tab") as Element,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "セッションを複製" }));
    expect(onDuplicate).toHaveBeenCalledWith(SID2);
  });
});
