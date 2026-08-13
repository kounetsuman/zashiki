// Parse/serialize the save/restore save file (saves/last.tsv).
// The format is TSV of `widx\twname\tcwd\tsid`.

/** One line of the save file = one window. */
export interface SaveEntry {
  /** Window ordinal (for display/compatibility; not used when restoring). */
  widx: string;
  wname: string;
  cwd: string;
  sid: string;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Whether sid is in UUID form. The legacy cw jsonl fallback can save non-UUID
 * values (this has been observed), so the restore side validates with this
 * before passing to claude --resume (this also guards against mixing arbitrary
 * strings into literal keystrokes sent to the shell).
 */
export function isUuidSid(sid: string): boolean {
  return UUID_RE.test(sid);
}

/**
 * Parse the save file. Malformed lines (fewer than 4 columns, empty cwd/sid)
 * are skipped and extra columns are ignored (the same leniency as how
 * cw-restore reads it).
 */
export function parseSaveFile(text: string): SaveEntry[] {
  const entries: SaveEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    if (fields.length < 4) continue;
    const [widx = "", wname = "", cwd = "", sid = ""] = fields;
    if (cwd.length === 0 || sid.length === 0) continue;
    entries.push({ widx, wname, cwd, sid });
  }
  return entries;
}

/** Keep tabs and newlines out of a field (prevents corrupting the format). */
function sanitizeField(value: string): string {
  return value.replace(/[\t\n\r]+/g, " ");
}

/** Serialize back to last.tsv-compatible TSV (newline at each line end). */
export function serializeSaveFile(entries: readonly SaveEntry[]): string {
  return entries
    .map(
      (e) =>
        `${sanitizeField(e.widx)}\t${sanitizeField(e.wname)}\t${sanitizeField(e.cwd)}\t${sanitizeField(e.sid)}\n`,
    )
    .join("");
}
