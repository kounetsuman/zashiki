import { type NotifyKind, playNotifySound } from "./notify-sound.js";

export type { NotifyKind } from "./notify-sound.js";

/** localStorage key for the client setting equivalent to ZK_NOTIFY ("1"/"0"; default on). */
export const NOTIFY_ENABLED_KEY = "zk.notify.enabled";

export type NotifyPermission = NotificationPermission | "unsupported";

export interface NotificationLike {
  // biome-ignore lint/suspicious/noExplicitAny: to be structurally compatible with the DOM's Notification.onclick (this: Notification)
  onclick: ((this: any, ev: any) => unknown) | null;
}

/** The minimal surface of the Notification API (swapped in tests). */
export interface NotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  create(
    title: string,
    options: { body?: string; tag?: string },
  ): NotificationLike;
}

export interface NotifyOptions {
  kind: NotifyKind;
  title: string;
  body?: string;
  /** Key that collapses a session's notifications down to the latest one. */
  tag?: string;
  /** On notification click (the caller does window.focus + focus jump). */
  onClick?: () => void;
}

export interface Notifier {
  isEnabled(): boolean;
  setEnabled(v: boolean): void;
  /**
   * Applies the enabled/disabled state from the server's config file (config.json ->
   * config.sync). It is held as an in-memory override without rewriting localStorage, so it
   * does not encroach on the fallback initial value (localStorage) used when the server is disconnected.
   */
  applyServerConfig(enabled: boolean): void;
  permission(): NotifyPermission;
  requestPermission(): Promise<NotifyPermission>;
  notify(opts: NotifyOptions): void;
  /** Plays the notification sound only (no OS notification), honoring the enabled setting. */
  playSound(kind: NotifyKind): void;
}

export interface NotifierDeps {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** null = an environment without the Notification API (sound only). */
  api?: NotificationApi | null;
  playSound?: (kind: NotifyKind) => void;
}

function defaultApi(): NotificationApi | null {
  if (typeof Notification === "undefined") return null;
  return {
    get permission() {
      return Notification.permission;
    },
    requestPermission: () => Notification.requestPermission(),
    create: (title, options) => new Notification(title, options),
  };
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * Web Notification + notification sound. On/off is governed by the server's config.json
 * (config.sync) and applied as an in-memory override. Before config.sync arrives, it follows
 * the localStorage fallback initial value. Visible notifications appear only when permitted
 * (permission=granted). Sound needs no permission, so it always plays when on.
 */
export function createNotifier(deps: NotifierDeps = {}): Notifier {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const api = deps.api === undefined ? defaultApi() : deps.api;
  const playSound = deps.playSound ?? playNotifySound;

  // Override from server config (null = not arrived -> localStorage fallback)
  let serverOverride: boolean | null = null;

  const isEnabled = (): boolean =>
    serverOverride ?? storage?.getItem(NOTIFY_ENABLED_KEY) !== "0";

  return {
    isEnabled,
    setEnabled(v) {
      storage?.setItem(NOTIFY_ENABLED_KEY, v ? "1" : "0");
    },
    applyServerConfig(enabled) {
      serverOverride = enabled;
    },
    permission() {
      return api === null ? "unsupported" : api.permission;
    },
    async requestPermission() {
      if (api === null) return "unsupported";
      return api.requestPermission();
    },
    playSound(kind) {
      if (!isEnabled()) return;
      try {
        playSound(kind);
      } catch {
        // Sound is best-effort
      }
    },
    notify(opts) {
      if (!isEnabled()) return;
      try {
        playSound(opts.kind);
      } catch {
        // Sound is best-effort
      }
      if (api === null || api.permission !== "granted") return;
      try {
        const n = api.create(opts.title, { body: opts.body, tag: opts.tag });
        if (opts.onClick) {
          const onClick = opts.onClick;
          n.onclick = () => onClick();
        }
      } catch {
        // A failure to show the notification must not break the app
      }
    },
  };
}
