import { describe, expect, it } from "vitest";

import {
  createNotifier,
  NOTIFY_ENABLED_KEY,
  type NotificationApi,
  type NotificationLike,
  type NotifyKind,
} from "./notify.js";

interface CreatedNotification extends NotificationLike {
  title: string;
  options: { body?: string; tag?: string };
}

function fakeApi(permission: NotificationPermission) {
  const created: CreatedNotification[] = [];
  let current = permission;
  const requested: number[] = [];
  const api: NotificationApi = {
    get permission() {
      return current;
    },
    requestPermission: () => {
      requested.push(1);
      current = "granted";
      return Promise.resolve(current);
    },
    create(title, options) {
      const n: CreatedNotification = { title, options, onclick: null };
      created.push(n);
      return n;
    },
  };
  return { api, created, requested };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function fakeSound() {
  const played: NotifyKind[] = [];
  return { played, play: (kind: NotifyKind) => void played.push(kind) };
}

describe("createNotifier", () => {
  it("is enabled by default; setEnabled(false) persists to localStorage", () => {
    const storage = fakeStorage();
    const n = createNotifier({ storage, api: null, playSound: () => {} });
    expect(n.isEnabled()).toBe(true);
    n.setEnabled(false);
    expect(storage.map.get(NOTIFY_ENABLED_KEY)).toBe("0");
    // The setting survives in a separate instance (equivalent to a reload)
    const n2 = createNotifier({ storage, api: null, playSound: () => {} });
    expect(n2.isEnabled()).toBe(false);
  });

  it("enabled + granted: creates a notification, plays sound, and calls onClick on click", () => {
    const { api, created } = fakeApi("granted");
    const sound = fakeSound();
    const clicks: string[] = [];
    const n = createNotifier({
      storage: fakeStorage(),
      api,
      playSound: sound.play,
    });
    n.notify({
      kind: "waiting",
      title: "⏳ 応答待ち myrepo",
      body: "最初のプロンプト",
      tag: "zk-@1",
      onClick: () => clicks.push("clicked"),
    });
    expect(sound.played).toEqual(["waiting"]);
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("⏳ 応答待ち myrepo");
    expect(created[0]?.options).toEqual({
      body: "最初のプロンプト",
      tag: "zk-@1",
    });
    created[0]?.onclick?.call(null, {});
    expect(clicks).toEqual(["clicked"]);
  });

  it("does nothing when disabled (no sound, no notification)", () => {
    const { api, created } = fakeApi("granted");
    const sound = fakeSound();
    const n = createNotifier({
      storage: fakeStorage({ [NOTIFY_ENABLED_KEY]: "0" }),
      api,
      playSound: sound.play,
    });
    n.notify({ kind: "done", title: "t" });
    expect(sound.played).toEqual([]);
    expect(created).toEqual([]);
  });

  it("plays only sound and shows no notification when permission is absent (default)", () => {
    const { api, created } = fakeApi("default");
    const sound = fakeSound();
    const n = createNotifier({
      storage: fakeStorage(),
      api,
      playSound: sound.play,
    });
    n.notify({ kind: "done", title: "t" });
    expect(sound.played).toEqual(["done"]);
    expect(created).toEqual([]);
  });

  it("delegates requestPermission to the API", async () => {
    const { api, requested } = fakeApi("default");
    const n = createNotifier({
      storage: fakeStorage(),
      api,
      playSound: () => {},
    });
    expect(n.permission()).toBe("default");
    expect(await n.requestPermission()).toBe("granted");
    expect(requested).toHaveLength(1);
    expect(n.permission()).toBe("granted");
  });

  it("reports unsupported in environments without the Notification API (sound still plays)", async () => {
    const sound = fakeSound();
    const n = createNotifier({
      storage: fakeStorage(),
      api: null,
      playSound: sound.play,
    });
    expect(n.permission()).toBe("unsupported");
    expect(await n.requestPermission()).toBe("unsupported");
    n.notify({ kind: "waiting", title: "t" });
    expect(sound.played).toEqual(["waiting"]);
  });

  it("applyServerConfig overrides enabled/disabled in-memory without modifying localStorage", () => {
    const storage = fakeStorage();
    const n = createNotifier({ storage, api: null, playSound: () => {} });
    // Disabled by server config -> isEnabled is false, but localStorage is untouched
    n.applyServerConfig(false);
    expect(n.isEnabled()).toBe(false);
    expect(storage.map.has(NOTIFY_ENABLED_KEY)).toBe(false);
    // A separate instance (equivalent to config not yet arrived) stays enabled following the localStorage default
    const fresh = createNotifier({ storage, api: null, playSound: () => {} });
    expect(fresh.isEnabled()).toBe(true);
    // Can be re-enabled via server config
    n.applyServerConfig(true);
    expect(n.isEnabled()).toBe(true);
  });

  it("applyServerConfig(false) override stops notifications even when localStorage is enabled", () => {
    const { api, created } = fakeApi("granted");
    const sound = fakeSound();
    const n = createNotifier({
      storage: fakeStorage(), // default = enabled
      api,
      playSound: sound.play,
    });
    n.applyServerConfig(false);
    n.notify({ kind: "done", title: "t" });
    expect(sound.played).toEqual([]);
    expect(created).toEqual([]);
  });
});
