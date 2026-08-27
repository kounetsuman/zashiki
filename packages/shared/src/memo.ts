import { z } from "zod";

/**
 * REST contract for saving the single app-wide memo (`POST /api/memo`). The memo is stored as
 * `<repos.conf dir>/memo.md`; a blank/whitespace-only `text` deletes it. After the write the server
 * broadcasts `memo.sync` so every client reflects the change without a restart.
 */

/** Max memo length (string length, matching the server's `.chars().count()` cap). The memo rides memo.sync, so it is bounded. */
export const MEMO_MAX_CHARS = 100_000;

export const memoRequestSchema = z.object({
  /** The memo body (Markdown). A blank value removes the memo. */
  text: z.string().max(MEMO_MAX_CHARS),
});
export type MemoRequest = z.infer<typeof memoRequestSchema>;
