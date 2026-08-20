import type { Notification } from "@zashiki/shared";
import { useCallback, useEffect, useState } from "react";
import { loadSeenIds, saveSeenIds } from "../lib/notifications-seen.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

export interface SeenNotifications {
  seenIds: string[];
  markRead(id: string): void;
}

/**
 * Tracks which notifications the user has seen (persisted in localStorage) for the unread badge.
 * Notifications are marked read individually; ids for notifications that are gone are dropped so
 * storage does not grow without bound.
 */
export function useSeenNotifications(
  notifications: readonly Notification[],
  storage: StoragePart | null,
): SeenNotifications {
  const [seenIds, setSeenIds] = useState(() => loadSeenIds(storage));

  const markRead = useCallback((id: string) => {
    setSeenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
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
