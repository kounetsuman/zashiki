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
  /** Columns the widest record holds, above `header.length` when the read cut it to the cap. */
  readonly totalColumns: number;
  readonly rows: readonly DelimitedRow[];
  /** Per column: every filled cell parses as a number, so it compares numerically and aligns right. */
  readonly numericColumns: readonly boolean[];
}

const TAB_SEPARATED = /\.(tsv|tab)$/i;
const COMMA_SEPARATED = /\.csv$/i;

/** Candidates for a `.csv` whose delimiter is regional (`;` in much of Europe) or mislabelled. */
const CSV_DELIMITERS = [",", ";", "\t"];

/** Columns past this one are dropped while reading, no record being read that far across. */
export const MAX_TABLE_COLUMNS = 200;

/** How much of the file the delimiter is guessed from. */
const DETECTION_BYTES = 64 * 1024;
const DETECTION_RECORDS = 20;

const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * A comma inside a number is a thousands mark to one locale and the decimal point to another,
 * so it is only read as a number where the file itself writes columns with commas.
 */
const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

export function isDelimitedText(relPath: string): boolean {
  return TAB_SEPARATED.test(relPath) || COMMA_SEPARATED.test(relPath);
}

export function numericValue(cell: string): number | null {
  const trimmed = cell.trim();
  if (!PLAIN_NUMBER.test(trimmed) && !GROUPED_NUMBER.test(trimmed)) return null;
  const value = Number(trimmed.replaceAll(",", ""));
  if (!Number.isFinite(value)) return null;
  // Identifiers run longer than a double holds exactly; comparing them as numbers would call
  // distinct ids equal, so they are left to the text comparison, which reads digits in full.
  return Number.isInteger(value) && !Number.isSafeInteger(value) ? null : value;
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
  let recordStart = 0;

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
      recordStart = i + 1;
    } else {
      field += char;
      atFieldStart = false;
    }
  }
  // A quote that never closes swallows the rest of the file into one field. The records read
  // so far stand; from the one that opened it, the text is read again with quotes as plain
  // characters, so a stray quote costs its own record's shape rather than every line below it.
  if (inQuotes) {
    for (const record of parseRecords(
      text.slice(recordStart),
      delimiter,
      false,
    ))
      records.push({
        line: recordLine + record.line - 1,
        cells: record.cells,
      });
    return records;
  }
  if (field !== "" || cells.length > 0 || hasQuotedField) endRecord();

  return records;
}

interface DelimiterFit {
  /** Share of the sampled records the candidate splits at all. */
  readonly coverage: number;
  /** Share of them landing on the same number of columns. */
  readonly agreement: number;
  readonly columns: number;
}

const NO_FIT: DelimiterFit = { coverage: 0, agreement: 0, columns: 0 };

/**
 * Reach first, then width, then regularity, each measured on the column count most of the
 * records share. A delimiter reaching every record beats one that splits only some; among
 * those, the one most records see more columns through is reading the file rather than cutting
 * inside its text — while a single odd record cannot make that case on its own.
 */
function fitsBetter(fit: DelimiterFit, than: DelimiterFit): boolean {
  if (fit.coverage !== than.coverage) return fit.coverage > than.coverage;
  if (fit.columns !== than.columns) return fit.columns > than.columns;
  return fit.agreement > than.agreement;
}

/**
 * How well a candidate fits the sample, on the column count most of its records share. A
 * delimiter separates the columns of every record;
 * one merely written inside the text splits some records and leaves the rest whole, which is
 * what disqualifies it. The single exception allowed is a one-word header above a wider table.
 */
function delimiterFit(sample: string, delimiter: string): DelimiterFit {
  const records = parseRecords(sample, delimiter, true).slice(
    0,
    DETECTION_RECORDS,
  );
  const recordsPerCount = new Map<number, number>();
  let splitRecords = 0;
  for (const record of records) {
    const count = record.cells.length;
    if (count < 2) continue;
    splitRecords++;
    recordsPerCount.set(count, (recordsPerCount.get(count) ?? 0) + 1);
  }
  if (splitRecords < 2 || splitRecords < records.length - 1) return NO_FIT;

  let columns = 0;
  let agreeing = 0;
  for (const [count, reaching] of recordsPerCount) {
    if (reaching > agreeing || (reaching === agreeing && count > columns)) {
      columns = count;
      agreeing = reaching;
    }
  }
  return {
    coverage: splitRecords / records.length,
    agreement: agreeing / splitRecords,
    columns,
  };
}

/**
 * The delimiter the file's own rows agree on; where two fit equally, the one splitting into more
 * columns (a semicolon export whose header itself contains a comma). Rows whose column counts
 * vary still count as agreement on the delimiter, since a ragged export is still that export.
 */
function detectDelimiter(text: string): string {
  const sample = text.slice(0, DETECTION_BYTES);
  let best = CSV_DELIMITERS[0] as string;
  let bestFit = NO_FIT;
  for (const candidate of CSV_DELIMITERS) {
    const fit = delimiterFit(sample, candidate);
    if (fitsBetter(fit, bestFit)) {
      best = candidate;
      bestFit = fit;
    }
  }
  return best;
}

/** The header names one cell per column, the file's own header row being ragged or short. */
function headerRow(cells: readonly string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => cells[i] ?? "");
}

function isNumericColumn(
  rows: readonly DelimitedRow[],
  column: number,
  grouped: boolean,
): boolean {
  let filled = false;
  for (const row of rows) {
    const cell = (row.cells[column] ?? "").trim();
    if (cell === "") continue;
    if (
      (!PLAIN_NUMBER.test(cell) && !(grouped && GROUPED_NUMBER.test(cell))) ||
      numericValue(cell) === null
    )
      return false;
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
  const totalColumns = records.reduce(
    (max, record) => Math.max(max, record.cells.length),
    0,
  );
  const width = Math.min(totalColumns, MAX_TABLE_COLUMNS);
  // Rows keep the cells they have rather than being padded out to the width: a file whose
  // records differ in length costs its own content, not its widest record times its length.
  const rows = records.slice(1).map((record) => ({
    line: record.line,
    cells:
      record.cells.length > width ? record.cells.slice(0, width) : record.cells,
  }));
  return {
    delimiter,
    header: headerRow(records[0]?.cells ?? [], width),
    totalColumns,
    rows,
    numericColumns: Array.from({ length: width }, (_, column) =>
      isNumericColumn(rows, column, delimiter === ","),
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
