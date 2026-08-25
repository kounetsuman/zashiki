import type { FooterBand, UsageLimit } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import type { Notifier } from "../lib/notify.js";
import { usageBandReached } from "../session/status-footer.js";
import {
  dismissUsageWarning,
  EMPTY_USAGE_WARNING,
  reduceUsageWarning,
  type UsageWarningRecord,
} from "../session/usage-warning.js";

const STORAGE_KEY = "zk.usageWarning.session";

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function loadRecord(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): UsageWarningRecord {
  const raw = storage?.getItem(STORAGE_KEY);
  if (!raw) return EMPTY_USAGE_WARNING;
  try {
    const v = JSON.parse(raw) as Partial<UsageWarningRecord>;
    return {
      window: typeof v.window === "number" ? v.window : null,
      notified: v.notified === true,
      dismissed: v.dismissed === true,
    };
  } catch {
    return EMPTY_USAGE_WARNING;
  }
}

export interface UsageLimitWarningState {
  open: boolean;
  dismiss(): void;
}

export interface UsageLimitWarningDeps {
  limit: UsageLimit | undefined;
  band: FooterBand;
  notifier: Notifier;
  buildNotification(limit: UsageLimit): { title: string; body: string };
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

/**
 * Auto-opens the near-limit dialog and fires a notification the first time the current session reaches
 * `band` within a reset window, then stays quiet until dismissed or the window rolls over. The gating
 * lives in {@link ../session/usage-warning}; this only wires it to localStorage and the notifier.
 * The caller renders the dialog from the live limit so its percentage tracks usage as it climbs.
 */
export function useUsageLimitWarning({
  limit,
  band,
  notifier,
  buildNotification,
  storage = defaultStorage(),
}: UsageLimitWarningDeps): UsageLimitWarningState {
  const recordRef = useRef<UsageWarningRecord>(loadRecord(storage));
  const [open, setOpen] = useState(false);

  const latest = useRef({ limit, notifier, buildNotification, storage });
  latest.current = { limit, notifier, buildNotification, storage };

  const active = usageBandReached(limit, band);
  const window = limit?.resetsAt ?? null;

  useEffect(() => {
    const step = reduceUsageWarning(recordRef.current, { active, window });
    recordRef.current = step.record;
    latest.current.storage?.setItem(STORAGE_KEY, JSON.stringify(step.record));
    const current = latest.current.limit;
    if (step.shouldNotify && current) {
      latest.current.notifier.notify({
        kind: "waiting",
        tag: STORAGE_KEY,
        ...latest.current.buildNotification(current),
      });
    }
    setOpen(step.shouldOpen);
  }, [active, window]);

  return {
    open,
    dismiss() {
      recordRef.current = dismissUsageWarning(recordRef.current);
      latest.current.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify(recordRef.current),
      );
      setOpen(false);
    },
  };
}
