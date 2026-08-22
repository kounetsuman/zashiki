import { z } from "zod";

/**
 * REST contract for saving a per-org note (`POST /api/orgs/note`). The note is stored as
 * `<repos.conf dir>/notes/<org>.md`; a blank/whitespace-only `text` deletes it. After the write the
 * server broadcasts `notes.sync` so every client reflects the change without a restart.
 */

/** Max note body length (string length, matching the server's `.chars().count()` cap). Notes ride notes.sync, so the field is bounded. */
export const ORG_NOTE_MAX_CHARS = 100_000;

export const orgNoteRequestSchema = z.object({
  /** The org (root basename) whose note is being saved. */
  org: z.string().min(1),
  /** The note body (Markdown). A blank value removes the note. */
  text: z.string().max(ORG_NOTE_MAX_CHARS),
});
export type OrgNoteRequest = z.infer<typeof orgNoteRequestSchema>;
