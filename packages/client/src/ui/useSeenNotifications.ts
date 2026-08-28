import type { Notification } from "@zashiki/shared";
import { useCallback, useEffect, useState } from "react";
import { loadSeenIds, saveSeenIds } from "../lib/notifications-seen.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

export interface SeenNotifications {
  seenIds: string[];
  markRead(ids: readonly string[]): void;
}

/**
 * Tracks which notifications the user has seen (persisted in localStorage) for the unread badge.
 * Notifications are marked read individually or in bulk; ids for notifications that are gone are
 * dropped so storage does not grow without bound.
 */
export function useSeenNotifications(
  notifications: readonly Notification[],
  storage: StoragePart | null,
): SeenNotifications {
  const [seenIds, setSeenIds] = useState(() => loadSeenIds(storage));

  const markRead = useCallback((ids: readonly string[]) => {
    setSeenIds((prev) => {
      const added = ids.filter((id) => !prev.includes(id));
      return added.length === 0 ? prev : [...prev, ...added];
    });
  }, []);

  useEffect(() => {
    const live = new Set(notifications.map((n) => n.id));
    setSeenIds((prev) => {
      const next = prev.filter((id) => live.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [notifications]);

  useEffect(() => {
    saveSeenIds(storage, seenIds);
  }, [seenIds, storage]);

  return { seenIds, markRead };
}
