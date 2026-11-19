import type { StallRules } from "@zashiki/shared";
import { useCallback, useState } from "react";

import {
  loadStallRules,
  sanitizeStallRules,
  saveStallRules,
} from "../lib/stall-rules.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StoragePart | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** The stall rules for the whole app, loaded from and saved to storage (injectable for tests). */
export function useStallRules(
  storage: StoragePart | null = defaultStorage(),
): [StallRules, (rules: StallRules) => void] {
  const [rules, setRules] = useState(() => loadStallRules(storage));
  const save = useCallback(
    (next: StallRules) => {
      saveStallRules(storage, next);
      setRules(sanitizeStallRules(next));
    },
    [storage],
  );
  return [rules, save];
}
