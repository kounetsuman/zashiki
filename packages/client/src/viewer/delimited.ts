/**
 * Reading delimited text (CSV / TSV) as a table: parsing, column typing and sorting
 * (pure functions; rendering lives in DelimitedTableView).
 */

export type SortDirection = "asc" | "desc";

export interface SortState {
  readonly column: number;
  readonly direction: SortDirection;
}

export interface DelimitedRow {
  /** 1-based position in the file, so sorting can be undone and the row number shown. */
  readonly index: number;
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

/**
 * Splits into records. `quoted` follows RFC 4180 — a field opening with `"` runs until its
 * closing quote, so delimiters and newlines inside it are literal and `""` is one quote.
 * Tab-separated text has no such convention, so its quotes stay literal characters.
 */
function parseRecords(
  text: string,
  delimiter: string,
  quoted: boolean,
): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let atFieldStart = true;

  const endField = (): void => {
    cells.push(field);
    field = "";
    atFieldStart = true;
  };
  const endRecord = (): void => {
    endField();
    records.push(cells);
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
      continue;
    }
    if (quoted && atFieldStart && char === '"') {
      inQuotes = true;
      atFieldStart = false;
    } else if (char === delimiter) endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += char;
      atFieldStart = false;
    }
  }
  if (field !== "" || cells.length > 0) endRecord();

  return records.filter((record) => record.length > 1 || record[0] !== "");
}

/** The delimiter that splits the first record into the most columns (ties keep the earlier candidate). */
function detectDelimiter(text: string, quoted: boolean): string {
  let best = CSV_DELIMITERS[0] as string;
  let bestColumns = 0;
  for (const candidate of CSV_DELIMITERS) {
    const columns = parseRecords(text, candidate, quoted)[0]?.length ?? 0;
    if (columns > bestColumns) {
      best = candidate;
      bestColumns = columns;
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
  const delimiter = quoted ? detectDelimiter(source, quoted) : "\t";
  const records = parseRecords(source, delimiter, quoted);
  const width = records.reduce(
    (max, record) => Math.max(max, record.length),
    0,
  );
  const rows = records.slice(1).map((record, i) => ({
    index: i + 1,
    cells: padded(record, width),
  }));
  return {
    delimiter,
    header: padded(records[0] ?? [], width),
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
      return rowA.index - rowB.index;
    }
    return compareCells(a, b, numeric) * sign || rowA.index - rowB.index;
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
