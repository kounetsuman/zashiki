import type { ServerMessage, SessionInfo } from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import i18n from "../i18n/index.js";
import type { Notifier, NotifyOptions } from "../lib/notify.js";
import { createAppStore, newestAddedWindowId } from "./app-store.js";

function fakeControl() {
  const handlers = new Set<(m: ServerMessage) => void>();
  return {
    handlers,
    onMessage(fn: (m: ServerMessage) => void): () => void {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    emit(m: ServerMessage): void {
      for (const fn of [...handlers]) fn(m);
    },
  };
}

function fakeNotifier() {
  const notified: NotifyOptions[] = [];
  const notifier: Notifier = {
    isEnabled: () => true,
    setEnabled: () => undefined,
    applyServerConfig: () => undefined,
    permission: () => "granted",
    requestPermission: () => Promise.resolve("granted"),
    notify: (opts) => void notified.push(opts),
  };
  return { notifier, notified };
}

const session: SessionInfo = {
  windowId: "@1",
  name: "myrepo",
  org: "o",
  repo: "myrepo",
  state: "idle",
  title: "最初のプロンプト",
  active: true,
};

function sessionWith(windowId: string): SessionInfo {
  return { ...session, windowId };
}

function setup() {
  const control = fakeControl();
  const { notifier, notified } = fakeNotifier();
  const selected: string[] = [];
  const focused: number[] = [];
  const reconnects: number[] = [];
  let currentTermId: string | null = "term-current";
  const store = createAppStore({
    control,
    session: {
      select: (id) => void selected.push(id),
      reconnect: () => void reconnects.push(1),
      getTermId: () => currentTermId,
    },
    notifier,
    focusWindow: () => void focused.push(1),
  });
  const changes: number[] = [];
  const unsubscribe = store.subscribe(() => void changes.push(1));
  return {
    control,
    notified,
    selected,
    focused,
    reconnects,
    store,
    changes,
    unsubscribe,
    setTermId: (id: string | null) => {
      currentTermId = id;
    },
  };
}

describe("newestAddedWindowId", () => {
  it("returns the largest @N among newly added windows", () => {
    expect(
      newestAddedWindowId(
        [sessionWith("@1")],
        [sessionWith("@1"), sessionWith("@3"), sessionWith("@10")],
      ),
    ).toBe("@10");
  });

  it("returns null when there is no increment", () => {
    expect(
      newestAddedWindowId([sessionWith("@1")], [sessionWith("@1")]),
    ).toBeNull();
  });

  it("returns null when windows only decreased", () => {
    expect(
      newestAddedWindowId(
        [sessionWith("@1"), sessionWith("@2")],
        [sessionWith("@1")],
      ),
    ).toBeNull();
  });

  it("returns the windowId for a single owned (UUID) addition (numeric @N assumptions cannot capture it)", () => {
    const uuid = "0954e103-14ff-4406-bc6c-325449ef07ba";
    expect(newestAddedWindowId([], [sessionWith(uuid)])).toBe(uuid);
  });

  it("treats the last of next as newest for multiple simultaneous owned (UUID) additions", () => {
    const a = "0954e103-14ff-4406-bc6c-325449ef07ba";
    const b = "9fc5a92f-2222-4333-8444-555566667777";
    expect(newestAddedWindowId([], [sessionWith(a), sessionWith(b)])).toBe(b);
  });
});

describe("createAppStore", () => {
  it("mirrors notifications.sync into the snapshot (full replacement)", () => {
    const t = setup();
    const items = [
      {
        id: "restart-required",
        level: "warn" as const,
        title: "設定変更",
        body: null,
        createdAt: 1,
        sticky: true,
        dismissible: false,
      },
    ];
    t.control.emit({ t: "notifications.sync", items });
    expect(t.store.getSnapshot().notifications).toEqual(items);
    // An empty sync wipes them all (retraction).
    t.control.emit({ t: "notifications.sync", items: [] });
    expect(t.store.getSnapshot().notifications).toEqual([]);
  });

  it("mirrors state.sync / error into the snapshot and notifies subscribers", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: { o: "#7aa2f7" },
    });
    expect(t.store.getSnapshot().sessions).toEqual([session]);
    expect(t.store.getSnapshot().orgs).toEqual(["o"]);
    expect(t.store.getSnapshot().orgColors).toEqual({ o: "#7aa2f7" });
    t.control.emit({ t: "error", code: "x", message: "boom" });
    expect(t.store.getSnapshot().lastError).toBe("x: boom");
    expect(t.changes.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces invalid_message as an actionable outdated-server hint (not the raw code)", () => {
    const t = setup();
    t.control.emit({
      t: "error",
      code: "invalid_message",
      message: "invalid client message",
    });
    const shown = t.store.getSnapshot().lastError;
    expect(shown).toBe(i18n.t("errorDialog.outdatedServer"));
    expect(shown).not.toContain("invalid_message");
  });

  it("does not surface unknown_term in a dialog and reattaches if it targets the current term", () => {
    const t = setup();
    t.control.emit({
      t: "error",
      code: "unknown_term",
      message: "termId term-current is not open",
    });
    // A desync caused by a server restart cannot be fixed by user action, so it is not surfaced in a dialog.
    expect(t.store.getSnapshot().lastError).toBeNull();
    // If it targets the current term, reattach with a new termId to recover.
    expect(t.reconnects).toEqual([1]);
  });

  it("ignores unknown_term targeting an already-reattached stale term (prevents double reattach)", () => {
    const t = setup();
    // The current term already has the new termId. A late error targeting a past termId must not trigger a reattach.
    t.control.emit({
      t: "error",
      code: "unknown_term",
      message: "termId term-stale is not open",
    });
    expect(t.store.getSnapshot().lastError).toBeNull();
    expect(t.reconnects).toEqual([]);
  });

  it("clearError clears lastError and notifies subscribers", () => {
    const t = setup();
    t.control.emit({ t: "error", code: "x", message: "boom" });
    expect(t.store.getSnapshot().lastError).toBe("x: boom");
    const before = t.changes.length;
    t.store.clearError();
    expect(t.store.getSnapshot().lastError).toBeNull();
    expect(t.changes.length).toBeGreaterThan(before);
  });

  it("selectWindow updates the selection state and calls session.select", () => {
    const t = setup();
    t.store.selectWindow("@2");
    expect(t.store.getSnapshot().selectedWindowId).toBe("@2");
    expect(t.selected).toEqual(["@2"]);
  });

  it("resizeNonce is 0 in the initial snapshot", () => {
    const t = setup();
    expect(t.store.getSnapshot().resizeNonce).toBe(0);
  });

  it("selectWindow advances resizeNonce (on window switch, resends resize with the current view's actual size to reclaim a shared window)", () => {
    const t = setup();
    expect(t.store.getSnapshot().resizeNonce).toBe(0);
    t.store.selectWindow("@2");
    expect(t.store.getSnapshot().resizeNonce).toBe(1);
    t.store.selectWindow("@3");
    expect(t.store.getSnapshot().resizeNonce).toBe(2);
  });

  it("deselect resets selectedWindowId to null", () => {
    const t = setup();
    t.store.selectWindow("@2");
    expect(t.store.getSnapshot().selectedWindowId).toBe("@2");
    const before = t.changes.length;
    t.store.deselect();
    expect(t.store.getSnapshot().selectedWindowId).toBeNull();
    expect(t.changes.length).toBeGreaterThan(before);
  });

  it("deselect does not notify when already unselected (avoids a wasteful re-render)", () => {
    const t = setup();
    const before = t.changes.length;
    t.store.deselect();
    expect(t.changes.length).toBe(before);
  });

  it("calls session.reconnect on receiving term.reconnect", () => {
    const t = setup();
    t.control.emit({ t: "term.reconnect", termIds: ["old-term"] });
    expect(t.reconnects).toEqual([1]);
  });

  it("calls notifier.notify on receiving notify (per-kind title, summary body, tag aggregation)", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: [],
      orgColors: {},
    });
    t.control.emit({
      t: "notify",
      kind: "waiting",
      windowId: "@1",
      title: "myrepo",
    });
    expect(t.notified).toHaveLength(1);
    expect(t.notified[0]?.title).toBe("⏳ 応答待ち myrepo");
    expect(t.notified[0]?.body).toBe("最初のプロンプト");
    expect(t.notified[0]?.tag).toBe("zk-@1");
  });

  it("brings to front and jumps focus on notification click", () => {
    const t = setup();
    t.control.emit({
      t: "notify",
      kind: "done",
      windowId: "@1",
      title: "myrepo",
    });
    expect(t.notified[0]?.title).toBe("✅ 完了 myrepo");
    t.notified[0]?.onClick?.();
    expect(t.focused).toEqual([1]);
    expect(t.selected).toEqual(["@1"]);
    expect(t.store.getSnapshot().selectedWindowId).toBe("@1");
  });

  it("brings to front and selects the window on select, without notifying", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: [],
      orgColors: {},
    });
    t.control.emit({ t: "select", windowId: "@1" });
    expect(t.focused).toEqual([1]);
    expect(t.selected).toEqual(["@1"]);
    expect(t.store.getSnapshot().selectedWindowId).toBe("@1");
    expect(t.notified).toHaveLength(0);
  });

  it("ignores select for an unknown (already-closed) window", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: [],
      orgColors: {},
    });
    t.control.emit({ t: "select", windowId: "@2" });
    expect(t.focused).toEqual([]);
    expect(t.selected).toEqual([]);
    expect(t.store.getSnapshot().selectedWindowId).toBeNull();
  });

  it("auto-selects the newest added window on state.sync after markNewRequested", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().selectedWindowId).toBe("@5");
    expect(t.selected).toEqual(["@5"]);
  });

  it("selects the largest @N (newest) when multiple windows are added at once", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@7"), sessionWith("@3")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().selectedWindowId).toBe("@7");
  });

  it("does not auto-select on state.sync without markNewRequested", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().selectedWindowId).toBeNull();
    expect(t.selected).toEqual([]);
  });

  it("holds the selection when a sync adds no window after a new request, and selects once one is added next", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().selectedWindowId).toBeNull();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@9")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().selectedWindowId).toBe("@9");
  });

  it("clears the pending new request on receiving error (prevents mistaking a failed request)", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.store.markNewRequested();
    t.control.emit({ t: "error", code: "unknown_org", message: "x" });
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().selectedWindowId).toBeNull();
  });

  it("focusNonce is 0 in the initial snapshot", () => {
    const t = setup();
    expect(t.store.getSnapshot().focusNonce).toBe(0);
  });

  it("increments focusNonce by 1 when a new request is reflected and auto-selected", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().focusNonce).toBe(0);
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().focusNonce).toBe(1);
  });

  it("increments focusNonce each time a window is added across consecutive new requests", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@2")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().focusNonce).toBe(1);
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@2"), sessionWith("@3")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().focusNonce).toBe(2);
  });

  it("does not increment focusNonce on a normal sync without markNewRequested", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().focusNonce).toBe(0);
  });

  it("does not increment focusNonce when a sync adds no window after a new request", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().focusNonce).toBe(0);
  });

  it("focusTerminal increments focusNonce by 1 (double-clicking the list focuses the terminal)", () => {
    const t = setup();
    expect(t.store.getSnapshot().focusNonce).toBe(0);
    t.store.focusTerminal();
    expect(t.store.getSnapshot().focusNonce).toBe(1);
    t.store.focusTerminal();
    expect(t.store.getSnapshot().focusNonce).toBe(2);
  });

  it("does not increment focusNonce on selectWindow (list/notification click)", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@2")],
      orgs: ["o"],
      orgColors: {},
    });
    t.store.selectWindow("@2");
    expect(t.store.getSnapshot().focusNonce).toBe(0);
  });

  it("clearNonce is 0 in the initial snapshot", () => {
    const t = setup();
    expect(t.store.getSnapshot().clearNonce).toBe(0);
  });

  it("does not increment clearNonce when selectWindow makes the first selection from null", () => {
    const t = setup();
    expect(t.store.getSnapshot().selectedWindowId).toBe(null);
    t.store.selectWindow("@2");
    expect(t.store.getSnapshot().clearNonce).toBe(0);
  });

  it("increments clearNonce by 1 when selectWindow switches from non-null to a different windowId", () => {
    const t = setup();
    // First selection from null: clearNonce does not increment.
    t.store.selectWindow("@2");
    expect(t.store.getSnapshot().clearNonce).toBe(0);
    // Switching to a different session: +1.
    t.store.selectWindow("@3");
    expect(t.store.getSnapshot().clearNonce).toBe(1);
  });

  it("does not increment clearNonce when selectWindow specifies the same windowId", () => {
    const t = setup();
    t.store.selectWindow("@2");
    t.store.selectWindow("@3"); // Switch to @3 (clearNonce = 1).
    t.store.selectWindow("@3"); // Re-select the same @3 (stays 1).
    expect(t.store.getSnapshot().clearNonce).toBe(1);
  });

  it("does not increment clearNonce when the new-request auto-select happens with a null selectedWindowId", () => {
    const t = setup();
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().clearNonce).toBe(0);
  });

  it("increments clearNonce by 1 when the new-request auto-select occurs while an existing session is selected", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    // First selection from null, so clearNonce does not increment.
    t.store.selectWindow(session.windowId);
    expect(t.store.getSnapshot().clearNonce).toBe(0);
    // A new session is added while an existing one is selected, so switching to a different session adds +1.
    t.store.markNewRequested();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().clearNonce).toBe(1);
  });

  it("does not increment clearNonce on state.sync without markNewRequested", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().clearNonce).toBe(0);
  });

  it("does not increment focusNonce when the pending release is triggered by an error", () => {
    const t = setup();
    t.control.emit({
      t: "state.sync",
      sessions: [session],
      orgs: ["o"],
      orgColors: {},
    });
    t.store.markNewRequested();
    t.control.emit({ t: "error", code: "unknown_org", message: "x" });
    t.control.emit({
      t: "state.sync",
      sessions: [session, sessionWith("@5")],
      orgs: ["o"],
      orgColors: {},
    });
    expect(t.store.getSnapshot().focusNonce).toBe(0);
  });

  it("attaches the real subscription to control on the first subscribe and detaches it on the last unsubscribe", () => {
    const control = fakeControl();
    const { notifier } = fakeNotifier();
    const store = createAppStore({
      control,
      session: {
        select: () => undefined,
        reconnect: () => undefined,
        getTermId: () => null,
      },
      notifier,
    });
    expect(control.handlers.size).toBe(0);
    const off1 = store.subscribe(() => undefined);
    const off2 = store.subscribe(() => undefined);
    expect(control.handlers.size).toBe(1);
    off1();
    expect(control.handlers.size).toBe(1);
    off2();
    expect(control.handlers.size).toBe(0);
  });
});
