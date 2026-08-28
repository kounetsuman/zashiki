import { describe, expect, it } from "vitest";

import {
  appendNotification,
  dismissNotification,
  errorNotification,
  type Notification,
  notificationSchema,
  notifyNotification,
  PTY_PRESSURE_ID,
  ptyPressureNotification,
  RESTART_REQUIRED_ID,
  removeNotification,
  restartRequiredNotification,
  rootsChanged,
  UPDATE_AVAILABLE_ID_PREFIX,
  unreadCount,
  updateAvailableVersion,
  upsertNotification,
} from "./notifications.js";

function n(
  id: string,
  createdAt: number,
  over: Partial<Notification> = {},
): Notification {
  return {
    id,
    level: "info",
    title: id,
    body: null,
    createdAt,
    sticky: false,
    dismissible: true,
    ...over,
  };
}

describe("notificationSchema", () => {
  it("fills in defaults (level=info / body=null / sticky, dismissible)", () => {
    const parsed = notificationSchema.parse({
      id: "x",
      title: "t",
      createdAt: 1,
    });
    expect(parsed).toEqual({
      id: "x",
      level: "info",
      title: "t",
      body: null,
      createdAt: 1,
      sticky: false,
      dismissible: true,
    });
  });
});

describe("upsertNotification", () => {
  it("replaces same id and sorts newest first", () => {
    const list = [n("a", 10), n("b", 20)];
    const next = upsertNotification(list, n("a", 30, { title: "A2" }));
    expect(next.map((x) => x.id)).toEqual(["a", "b"]);
    expect(next[0]?.title).toBe("A2");
  });

  it("appends new entries", () => {
    const next = upsertNotification([n("a", 10)], n("c", 5));
    expect(next.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("orders ties deterministically by id when timestamps are equal", () => {
    const next = upsertNotification([n("b", 10)], n("a", 10));
    expect(next.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("dismissNotification", () => {
  it("dismisses only dismissible notifications", () => {
    const list = [
      n("a", 1, { dismissible: true }),
      n("b", 2, { dismissible: false }),
    ];
    expect(dismissNotification(list, "a").map((x) => x.id)).toEqual(["b"]);
  });

  it("does not dismiss non-dismissible ones (a sticky restart-required notice cannot be dismissed manually)", () => {
    const list = [n("b", 2, { dismissible: false })];
    expect(dismissNotification(list, "b")).toEqual(list);
  });
});

describe("removeNotification", () => {
  it("removes by id regardless of dismissible (server-driven removal)", () => {
    const list = [n("b", 2, { dismissible: false })];
    expect(removeNotification(list, "b")).toEqual([]);
  });
});

describe("unreadCount", () => {
  it("counts notifications not in seen", () => {
    const list = [n("a", 1), n("b", 2), n("c", 3)];
    expect(unreadCount(list, ["b"])).toBe(2);
    expect(unreadCount(list, ["a", "b", "c"])).toBe(0);
    expect(unreadCount(list, [])).toBe(3);
  });
});

describe("rootsChanged", () => {
  it("changes when the lengths differ", () => {
    expect(rootsChanged(["/a"], ["/a", "/b"])).toBe(true);
  });
  it("stays unchanged for identical content and order", () => {
    expect(rootsChanged(["/a", "/b"], ["/a", "/b"])).toBe(false);
  });
  it("changes when the order differs (it affects the org display order)", () => {
    expect(rootsChanged(["/a", "/b"], ["/b", "/a"])).toBe(true);
  });
  it("changes when an element differs", () => {
    expect(rootsChanged(["/a"], ["/z"])).toBe(true);
  });
});

describe("restartRequiredNotification", () => {
  it("fixed ID, sticky, non-dismissible, warn", () => {
    const r = restartRequiredNotification(123);
    expect(r.id).toBe(RESTART_REQUIRED_ID);
    expect(r.sticky).toBe(true);
    expect(r.dismissible).toBe(false);
    expect(r.level).toBe("warn");
    expect(r.createdAt).toBe(123);
  });
});

describe("ptyPressureNotification", () => {
  it("fixed id, dismissible, non-sticky; includes usage/limit in the body", () => {
    const r = ptyPressureNotification(498, 511, "warn", 999);
    expect(r.id).toBe(PTY_PRESSURE_ID);
    expect(r.dismissible).toBe(true);
    expect(r.sticky).toBe(false);
    expect(r.level).toBe("warn");
    expect(r.body).toContain("498");
    expect(r.body).toContain("511");
    expect(r.createdAt).toBe(999);
  });

  it("block is the error level", () => {
    expect(ptyPressureNotification(500, 511, "block", 1).level).toBe("error");
  });

  it("is replaced by upsert without proliferating because the id is fixed", () => {
    let list = upsertNotification(
      [],
      ptyPressureNotification(400, 511, "warn", 1),
    );
    list = upsertNotification(
      list,
      ptyPressureNotification(490, 511, "block", 2),
    );
    expect(list.filter((x) => x.id === PTY_PRESSURE_ID)).toHaveLength(1);
    expect(list.find((x) => x.id === PTY_PRESSURE_ID)?.level).toBe("error");
  });
});

describe("errorNotification", () => {
  it("error level, dismissible, non-sticky; code=title / message=body", () => {
    const r = errorNotification("id-1", "pty_exhausted", "枯渇しました", 42);
    expect(r.id).toBe("id-1");
    expect(r.level).toBe("error");
    expect(r.title).toBe("pty_exhausted");
    expect(r.body).toBe("枯渇しました");
    expect(r.dismissible).toBe(true);
    expect(r.sticky).toBe(false);
    expect(r.createdAt).toBe(42);
  });

  it("id is unique per occurrence (the same code can accumulate)", () => {
    const a = errorNotification("id-1", "internal", "x", 1);
    const b = errorNotification("id-2", "internal", "y", 2);
    const list = upsertNotification(upsertNotification([], a), b);
    expect(list).toHaveLength(2);
  });
});

describe("notifyNotification", () => {
  it("waiting is awaiting-response, info, dismissible", () => {
    const r = notifyNotification("id-1", "waiting", "my-window", 7);
    expect(r.level).toBe("info");
    expect(r.title).toContain("応答待ち");
    expect(r.title).toContain("my-window");
    expect(r.dismissible).toBe(true);
    expect(r.sticky).toBe(false);
    expect(r.createdAt).toBe(7);
  });

  it("done is completed", () => {
    expect(notifyNotification("id-2", "done", "w", 1).title).toContain("完了");
  });

  it("labels the Background Activity kinds", () => {
    expect(
      notifyNotification("id-3", "subagent_start", "w", 1).title,
    ).toContain("サブエージェント開始");
    expect(notifyNotification("id-4", "shell_end", "w", 1).title).toContain(
      "バックグラウンドシェル終了",
    );
  });
});

describe("appendNotification (capped append)", () => {
  it("behaves like upsert below max (newest first)", () => {
    const next = appendNotification([n("a", 10)], n("b", 20), 10);
    expect(next.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("replaces the same id without proliferating", () => {
    const next = appendNotification([n("a", 10)], n("a", 30), 10);
    expect(next).toHaveLength(1);
    expect(next[0]?.createdAt).toBe(30);
  });

  it("evicts oldest dismissible first when over max", () => {
    let list: Notification[] = [];
    for (let i = 1; i <= 5; i++)
      list = appendNotification(list, n(`e${i}`, i), 3);
    expect(list.map((x) => x.id)).toEqual(["e5", "e4", "e3"]);
  });

  it("does not evict sticky / non-dismissible ones (keeps them even over the cap)", () => {
    let list: Notification[] = [
      n("keep-sticky", 1, { sticky: true, dismissible: false }),
    ];
    for (let i = 1; i <= 5; i++)
      list = appendNotification(list, n(`e${i}`, i + 1), 2);
    expect(list.some((x) => x.id === "keep-sticky")).toBe(true);
    // Only max(0, 2-1)=1 evictable entry remains (the newest, e5)
    expect(list.filter((x) => x.id.startsWith("e")).map((x) => x.id)).toEqual([
      "e5",
    ]);
  });

  it("treats max<=0 as no cap", () => {
    let list: Notification[] = [];
    for (let i = 1; i <= 5; i++)
      list = appendNotification(list, n(`e${i}`, i), 0);
    expect(list).toHaveLength(5);
  });
});

describe("updateAvailableVersion", () => {
  const upd = (version: string, createdAt = 1): Notification =>
    n(`${UPDATE_AVAILABLE_ID_PREFIX}${version}`, createdAt);

  it("returns null when no update notification is present", () => {
    expect(updateAvailableVersion([n("a", 1), n("b", 2)])).toBeNull();
    expect(updateAvailableVersion([])).toBeNull();
  });

  it("extracts the version from the update-available notification", () => {
    expect(updateAvailableVersion([n("a", 1), upd("0.2.0")])).toBe("0.2.0");
  });

  it("picks the newest update-available version (list is newest-first)", () => {
    const list = upsertNotification(
      upsertNotification([], upd("0.2.0", 10)),
      upd("0.3.0", 20),
    );
    expect(updateAvailableVersion(list)).toBe("0.3.0");
  });

  it("returns null for a bare prefix with no version", () => {
    expect(
      updateAvailableVersion([n(UPDATE_AVAILABLE_ID_PREFIX, 1)]),
    ).toBeNull();
  });

  it("parses the server's literal id wire format (drift guard vs crates/zashiki-server)", () => {
    expect(updateAvailableVersion([n("update-available:0.2.0", 1)])).toBe(
      "0.2.0",
    );
  });
});
