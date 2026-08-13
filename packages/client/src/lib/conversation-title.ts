/**
 * Persistence of user-edited titles for the conversation panel.
 * The key is claude's session-id (sid). Because sid survives resume, a custom
 * title re-matches even when the windowId is reassigned during a restore such
 * as a tmux restart.
 * sid is unique, so there is no need to guard against windowId reuse
 * (title "possession"). But to prevent contamination of the "undefined" bucket
 * when sid is missing (claude not started, or an old server), we reject sids
 * that fail UUID validation and, as a safeguard, keep the name (repository) it
 * was assigned with as a pair, verifying the match at display time.
 * Follows the localStorage "zk.*" naming convention. When unedited, it falls
 * back to the automatic title (or the name if absent).
 */

import { isUuidSid } from "@zashiki/shared";

export const CONVERSATION_TITLES_KEY = "zk.conversation.titles";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** Storage unit: a title plus the name of the session it was assigned to (repository, used for matching). */
export interface TitleEntry {
  title: string;
  name: string;
}

/** sid → title entry. Empty titles are not kept (i.e. fall back to the automatic title). */
export type TitleMap = Record<string, TitleEntry>;

/** Whether the sid can be used as a custom-title key (rejects missing or non-UUID values). */
function isKeyableSid(sid: string | undefined): sid is string {
  return sid !== undefined && isUuidSid(sid);
}

/**
 * Reads the persisted title map. Malformed values, empty titles, and non-UUID
 * keys (the old windowId format) are dropped. A map keyed by old windowIds
 * cannot be mapped onto sids, so it is discarded wholesale during migration.
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
 * Returns a new map with the edit committed (pure function). If the sid is
 * missing or non-UUID (claude not started, or an old server), it writes nothing
 * and returns the original map (preventing "undefined" bucket contamination and
 * cross-window mix-ups). If empty after trimming, it deletes the custom title
 * and falls back to the automatic one. The name is stored as a pair for matching.
 */
export function commitTitle(
  titles: TitleMap,
  sid: string | undefined,
  name: string,
  raw: string,
): TitleMap {
  if (!isKeyableSid(sid)) return titles;
  const trimmed = raw.trim();
  const next = { ...titles };
  if (trimmed === "") delete next[sid];
  else next[sid] = { title: trimmed, name };
  return next;
}

/**
 * Returns the manual title in effect for the current session (undefined if
 * none). Not used if the sid is missing or non-UUID. Only adopted when the name
 * (repository) saved with it matches the current session (a safeguard against
 * sid collisions and duplicate resumes).
 */
export function effectiveCustomTitle(
  titles: TitleMap,
  session: { sid?: string | undefined; name: string },
): string | undefined {
  if (!isKeyableSid(session.sid)) return undefined;
  const entry = titles[session.sid];
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
