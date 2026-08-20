import { authHeaders } from "../lib/token.js";

export interface CrashApi {
  /** The previous run's crash log tail, or null when it shut down cleanly. */
  last(): Promise<string | null>;
  /** Clears the crash so it is not shown again on the next launch. */
  ack(): Promise<void>;
}

const NEW_ISSUE_URL = "https://github.com/kounetsuman/zashiki/issues/new";

/** Cap for the whole issue URL, below the length GitHub/browsers reject. */
const ISSUE_URL_MAX = 6000;

const FENCE = "```";

/** A new-issue URL with `log` fenced in the body, trimmed by encoded length to fit [`ISSUE_URL_MAX`]. */
export function buildIssueUrl(log: string): string {
  for (const excerpt of shrinkingExcerpts(log)) {
    const body = `${FENCE}\n${excerpt}\n${FENCE}\n`;
    const url = `${NEW_ISSUE_URL}?body=${encodeURIComponent(body)}`;
    if (url.length <= ISSUE_URL_MAX) return url;
  }
  return NEW_ISSUE_URL;
}

/** `log` and successively shorter tails of it (by code point), ending at empty. */
function* shrinkingExcerpts(log: string): Generator<string> {
  const points = Array.from(log);
  yield log;
  for (
    let keep = Math.floor(points.length / 2);
    keep >= 0;
    keep = Math.floor(keep / 2)
  ) {
    yield points.slice(points.length - keep).join("");
    if (keep === 0) break;
  }
}

export function createCrashApi(
  base: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): CrashApi {
  return {
    async last() {
      const res = await fetchFn(`${base}/api/last-crash`, {
        headers: authHeaders(token),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { log?: string | null };
      return typeof body.log === "string" ? body.log : null;
    },
    async ack() {
      await fetchFn(`${base}/api/last-crash/ack`, {
        method: "POST",
        headers: authHeaders(token),
      });
    },
  };
}
