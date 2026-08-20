/**
 * Persistence of user-edited titles for the conversation panel.
 * The key is the session's cockpitTerminalId. In owned mode the cockpitTerminalId is the session's
 * stable UUID: it is generated at session.new, launched as `claude --session-id
 * <cockpitTerminalId>`, and preserved across resume/restore (the registry is rebuilt under
 * the same id). So a title stays attached for the whole life of the session,
 * independent of whether a claude process is detected at any given moment.
 * cockpitTerminalId is unique per session, so there is no cross-session "possession" risk.
 * We reject non-UUID cockpitTerminalIds (unbound/plain-shell windows that are never
 * persisted); this also self-enforces the owned-mode assumption, since a legacy
 * tmux cockpitTerminalId (`@N`) is non-UUID and is simply treated as non-renamable. The
 * name (repository) is stored alongside the title to keep the storage format
 * stable and as a display-time consistency check (it normally always matches,
 * as cockpitTerminalId is unique). Follows the localStorage "zk.*" naming convention. When
 * unedited, it falls back to the automatic title (or the name if absent).
 */

import { isUuidSid } from "@zashiki/shared";

export const CONVERSATION_TITLES_KEY = "zk.conversation.titles";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** Storage unit: a title plus the name of the session it was assigned to (repository, used for matching). */
export interface TitleEntry {
  title: string;
  name: string;
}

/** cockpitTerminalId → title entry. Empty titles are not kept (i.e. fall back to the automatic title). */
export type TitleMap = Record<string, TitleEntry>;

/** Whether the cockpitTerminalId can be used as a custom-title key (rejects missing or non-UUID values). */
function isKeyableCockpitTerminalId(
  cockpitTerminalId: string | undefined,
): cockpitTerminalId is string {
  return cockpitTerminalId !== undefined && isUuidSid(cockpitTerminalId);
}

/**
 * Reads the persisted title map. Malformed values, empty titles, and non-UUID
 * keys (unbound/plain-shell windows, or the retired cockpitTerminalId=@N format) are
 * dropped. A map keyed by old tmux cockpitTerminalIds cannot be mapped onto the current
 * UUID cockpitTerminalIds, so it is discarded wholesale during migration.
 */
export function loadConversationTitles(storage: StoragePart | null): TitleMap {
  if (storage === null) return {};
  const raw = storage.getItem(CONVERSATION_TITLES_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: TitleMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isUuidSid(k)) continue;
    if (typeof v !== "object" || v === null) continue;
    const { title, name } = v as Partial<TitleEntry>;
    if (typeof title === "string" && title !== "" && typeof name === "string") {
      out[k] = { title, name };
    }
  }
  return out;
}

/**
 * Persists the title map (storage is injectable). Swallows a setItem throw when
 * localStorage is full or in private mode (titles are auxiliary information, so
 * a persistence failure must not drag down the editing flow, i.e. the caller's
 * setState).
 */
export function saveConversationTitles(
  storage: StoragePart | null,
  titles: TitleMap,
): void {
  try {
    storage?.setItem(CONVERSATION_TITLES_KEY, JSON.stringify(titles));
  } catch {
    // In an environment where writing is impossible, give up silently.
  }
}

/**
 * Returns a new map with the edit committed (pure function). If the cockpitTerminalId is
 * missing or non-UUID (an unbound/plain-shell window), it writes nothing and
 * returns the original map. If empty after trimming, it deletes the custom title
 * and falls back to the automatic one. The name is stored as a pair for matching.
 */
export function commitTitle(
  titles: TitleMap,
  cockpitTerminalId: string | undefined,
  name: string,
  raw: string,
): TitleMap {
  if (!isKeyableCockpitTerminalId(cockpitTerminalId)) return titles;
  const trimmed = raw.trim();
  const next = { ...titles };
  if (trimmed === "") delete next[cockpitTerminalId];
  else next[cockpitTerminalId] = { title: trimmed, name };
  return next;
}

/**
 * Returns the manual title in effect for the current session (undefined if
 * none). Not used if the cockpitTerminalId is missing or non-UUID. Only adopted when the
 * name (repository) saved with it matches the current session (normally always
 * true since cockpitTerminalId is unique; a defensive display-time check).
 */
export function effectiveCustomTitle(
  titles: TitleMap,
  session: { cockpitTerminalId?: string | undefined; name: string },
): string | undefined {
  if (!isKeyableCockpitTerminalId(session.cockpitTerminalId)) return undefined;
  const entry = titles[session.cockpitTerminalId];
  if (entry === undefined || entry.name !== session.name) return undefined;
  return entry.title === "" ? undefined : entry.title;
}

/** Display title: falls back in order edited title → automatic title → name. */
export function resolveTitle(
  custom: string | undefined,
  session: { title: string | null; name: string },
): string {
  if (custom !== undefined && custom !== "") return custom;
  return session.title ?? session.name;
}
