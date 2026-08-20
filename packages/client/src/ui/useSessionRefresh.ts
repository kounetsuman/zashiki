import { useRef, useState } from "react";
import type { RefreshState } from "./RefreshButton.js";

export interface SessionRefresh {
  state: RefreshState;
  error: string | null;
  refresh(): void;
}

/**
 * Drives the header refresh button. A Promise-returning onRefresh reflects loading then success/error
 * in the icon; a synchronous (void) return shows no status. A generation guard keeps a stale resolution
 * from a rapid earlier click from rolling back a newer fetch's display.
 */
export function useSessionRefresh(
  onRefresh: () => void | Promise<void>,
): SessionRefresh {
  const [state, setState] = useState<RefreshState>("idle");
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  const refresh = (): void => {
    const result = onRefresh();
    if (result === undefined) return;
    gen.current += 1;
    const g = gen.current;
    setState("loading");
    result.then(
      () => {
        if (g !== gen.current) return;
        setState("idle");
        setError(null);
      },
      (err: unknown) => {
        if (g !== gen.current) return;
        setState("error");
        setError(String(err));
      },
    );
  };

  return { state, error, refresh };
}
