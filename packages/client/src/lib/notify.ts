import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_SOUND_PRESET,
  type NotificationSettings,
  type NotifyCategory,
  type NotifyCategoryPref,
  type NotifyKind,
  notifyCategoryForKind,
  type SoundPreset,
} from "@zashiki/shared";

import { playNotifySound } from "./notify-sound.js";

export type { NotifyKind } from "@zashiki/shared";

/** localStorage key for the master switch fallback before config.sync arrives ("1"/"0"; default on). */
export const NOTIFY_ENABLED_KEY = "zk.notify.enabled";

/** The preset a kind plays before config.sync arrives: its historical per-category default. */
function fallbackSoundType(category: NotifyCategory | null): SoundPreset {
  return category === null
    ? DEFAULT_SOUND_PRESET
    : DEFAULT_NOTIFICATION_SETTINGS.categories[category].soundType;
}

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
  /** Whether the master switch is on (server config when present, else the localStorage fallback). */
  isEnabled(): boolean;
  setEnabled(v: boolean): void;
  /**
   * Applies the per-category switches from the server's config file (config.json -> config.sync).
   * Held as an in-memory override without rewriting localStorage, so it does not encroach on the
   * localStorage master fallback used when the server is disconnected.
   */
  applyServerConfig(settings: NotificationSettings): void;
  permission(): NotifyPermission;
  requestPermission(): Promise<NotifyPermission>;
  notify(opts: NotifyOptions): void;
  /** Plays the notification sound only (no OS notification), gated by the master + the category's sound. */
  playSound(kind: NotifyKind): void;
  /** Whether the category's visual should show (master + the category's notify). */
  shouldShow(kind: NotifyKind): boolean;
}

export interface NotifierDeps {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** null = an environment without the Notification API (sound only). */
  api?: NotificationApi | null;
  playSound?: (preset: SoundPreset) => void;
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
 * Web Notification + notification sound, gated per category by the server's config.json (config.sync)
 * applied as an in-memory override. Before config.sync arrives, the master follows the localStorage
 * fallback and every category shows and sounds. The visual appears only when permitted
 * (permission=granted); sound needs no permission, so it plays whenever the category's sound is on.
 */
export function createNotifier(deps: NotifierDeps = {}): Notifier {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const api = deps.api === undefined ? defaultApi() : deps.api;
  const playSound = deps.playSound ?? playNotifySound;

  // Override from server config (null = not arrived -> localStorage master fallback).
  let serverSettings: NotificationSettings | null = null;

  const isEnabled = (): boolean =>
    serverSettings
      ? serverSettings.enabled
      : storage?.getItem(NOTIFY_ENABLED_KEY) !== "0";

  const prefFor = (kind: NotifyKind): NotifyCategoryPref => {
    const category = notifyCategoryForKind(kind);
    if (serverSettings === null) {
      return {
        notify: true,
        sound: true,
        soundType: fallbackSoundType(category),
      };
    }
    return category === null
      ? { notify: false, sound: false, soundType: DEFAULT_SOUND_PRESET }
      : serverSettings.categories[category];
  };

  return {
    isEnabled,
    setEnabled(v) {
      storage?.setItem(NOTIFY_ENABLED_KEY, v ? "1" : "0");
    },
    applyServerConfig(settings) {
      serverSettings = settings;
    },
    permission() {
      return api === null ? "unsupported" : api.permission;
    },
    async requestPermission() {
      if (api === null) return "unsupported";
      return api.requestPermission();
    },
    playSound(kind) {
      const pref = prefFor(kind);
      if (!isEnabled() || !pref.sound) return;
      try {
        playSound(pref.soundType);
      } catch {
        // Sound is best-effort
      }
    },
    shouldShow(kind) {
      return isEnabled() && prefFor(kind).notify;
    },
    notify(opts) {
      if (!isEnabled()) return;
      const pref = prefFor(opts.kind);
      if (pref.sound) {
        try {
          playSound(pref.soundType);
        } catch {
          // Sound is best-effort
        }
      }
      if (!pref.notify) return;
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
