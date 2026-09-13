/**
 * Reading delimited text (CSV / TSV) as a table: parsing, column typing and sorting
 * (pure functions; rendering lives in DelimitedTable).
 */

export type SortDirection = "asc" | "desc";

export interface SortState {
  readonly column: number;
  readonly direction: SortDirection;
}

export interface DelimitedRow {
  /** 1-based line the record starts on, so the row number matches the text view and survives sorting. */
  readonly line: number;
  readonly cells: readonly string[];
}

export interface DelimitedTable {
  readonly delimiter: string;
  readonly header: readonly string[];
  readonly rows: readonly DelimitedRow[];
  /** Per column: every filled cell parses as a number, so it compares numerically and aligns right. */
  readonly numericColumns: readonly boolean[];
}

const TAB_SEPARATED = /\.(tsv|tab)$/i;
const COMMA_SEPARATED = /\.csv$/i;

/** Candidates for a `.csv` whose delimiter is regional (`;` in much of Europe) or mislabelled. */
const CSV_DELIMITERS = [",", ";", "\t"];

/** How much of the file the delimiter is guessed from. */
const DETECTION_BYTES = 64 * 1024;
const DETECTION_RECORDS = 10;

const NUMERIC_CELL =
  /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function isDelimitedText(relPath: string): boolean {
  return TAB_SEPARATED.test(relPath) || COMMA_SEPARATED.test(relPath);
}

export function numericValue(cell: string): number | null {
  const trimmed = cell.trim();
  if (!NUMERIC_CELL.test(trimmed)) return null;
  const value = Number(trimmed.replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface ParsedRecord {
  readonly line: number;
  readonly cells: string[];
}

/**
 * Splits into records. `quoted` follows RFC 4180 — a field opening with `"` runs until its
 * closing quote, so delimiters and newlines inside it are literal and `""` is one quote.
 * Tab-separated text has no such convention, so its quotes stay literal characters.
 * Blank lines carry no record; a quoted empty field is a record, being a written value.
 */
function parseRecords(
  text: string,
  delimiter: string,
  quoted: boolean,
): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let atFieldStart = true;
  let hasQuotedField = false;
  let line = 1;
  let recordLine = 1;

  const endField = (): void => {
    cells.push(field);
    field = "";
    atFieldStart = true;
  };
  const endRecord = (): void => {
    endField();
    if (hasQuotedField || cells.length > 1 || cells[0] !== "")
      records.push({ line: recordLine, cells });
    cells = [];
    hasQuotedField = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        field += "\n";
        line++;
      } else field += char;
      continue;
    }
    if (quoted && atFieldStart && char === '"') {
      inQuotes = true;
      hasQuotedField = true;
      atFieldStart = false;
    } else if (char === delimiter) endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += char;
      atFieldStart = false;
    }
  }
  if (field !== "" || cells.length > 0 || hasQuotedField) endRecord();

  return records;
}

/** The column count most of the sampled records agree on; 1 means the candidate does not split them. */
function delimiterScore(sample: string, delimiter: string): number {
  const seenPerCount = new Map<number, number>();
  for (const record of parseRecords(sample, delimiter, true).slice(
    0,
    DETECTION_RECORDS,
  )) {
    const count = record.cells.length;
    seenPerCount.set(count, (seenPerCount.get(count) ?? 0) + 1);
  }
  let columns = 0;
  let agreeing = 0;
  for (const [count, seen] of seenPerCount) {
    if (seen > agreeing || (seen === agreeing && count > columns)) {
      columns = count;
      agreeing = seen;
    }
  }
  return columns;
}

/**
 * The delimiter the file's own rows agree on. Scoring a sample rather than the first record
 * alone keeps a title line or a single-word header from hiding the real delimiter.
 */
function detectDelimiter(text: string): string {
  const sample = text.slice(0, DETECTION_BYTES);
  let best = CSV_DELIMITERS[0] as string;
  let bestScore = 0;
  for (const candidate of CSV_DELIMITERS) {
    const score = delimiterScore(sample, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function padded(cells: readonly string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => cells[i] ?? "");
}

function isNumericColumn(
  rows: readonly DelimitedRow[],
  column: number,
): boolean {
  let filled = false;
  for (const row of rows) {
    const cell = (row.cells[column] as string).trim();
    if (cell === "") continue;
    if (numericValue(cell) === null) return false;
    filled = true;
  }
  return filled;
}

/** Reads the file's text as a table whose first record is the header row. */
export function readDelimited(relPath: string, text: string): DelimitedTable {
  const quoted = !TAB_SEPARATED.test(relPath);
  const source = stripByteOrderMark(text);
  const delimiter = quoted ? detectDelimiter(source) : "\t";
  const records = parseRecords(source, delimiter, quoted);
  const width = records.reduce(
    (max, record) => Math.max(max, record.cells.length),
    0,
  );
  const rows = records.slice(1).map((record) => ({
    line: record.line,
    cells: padded(record.cells, width),
  }));
  return {
    delimiter,
    header: padded(records[0]?.cells ?? [], width),
    rows,
    numericColumns: Array.from({ length: width }, (_, column) =>
      isNumericColumn(rows, column),
    ),
  };
}

function compareCells(a: string, b: string, numeric: boolean): number {
  if (numeric) return (numericValue(a) ?? 0) - (numericValue(b) ?? 0);
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Sorts a copy of the rows; blank cells stay at the bottom in both directions. */
export function sortRows(
  rows: readonly DelimitedRow[],
  numericColumns: readonly boolean[],
  sort: SortState | null,
): readonly DelimitedRow[] {
  if (sort === null) return rows;
  const numeric = numericColumns[sort.column] === true;
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((rowA, rowB) => {
    const a = (rowA.cells[sort.column] ?? "").trim();
    const b = (rowB.cells[sort.column] ?? "").trim();
    if (a === "" || b === "") {
      if (a !== "") return -1;
      if (b !== "") return 1;
      return rowA.line - rowB.line;
    }
    return compareCells(a, b, numeric) * sign || rowA.line - rowB.line;
  });
}

/** The state a header click moves to: ascending, then descending, then back to file order. */
export function nextSort(
  current: SortState | null,
  column: number,
): SortState | null {
  if (current?.column !== column) return { column, direction: "asc" };
  return current.direction === "asc" ? { column, direction: "desc" } : null;
}
