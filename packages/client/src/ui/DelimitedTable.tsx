import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type DelimitedRow,
  MAX_TABLE_COLUMNS,
  nextSort,
  readDelimited,
  type SortState,
  sortRows,
} from "../viewer/delimited.js";

/** Rows past this one are left out: a whole large file in the DOM stalls the cockpit. */
export const MAX_RENDERED_ROWS = 2000;

/** The cell budget a wide file spends its rows against. */
const MAX_RENDERED_CELLS = 50_000;

/** The rows that fit both caps, counting the cells each row actually holds. */
function rowsWithinBudget(rows: readonly DelimitedRow[]): number {
  let cells = 0;
  const cap = Math.min(rows.length, MAX_RENDERED_ROWS);
  for (let i = 0; i < cap; i++) {
    cells += (rows[i] as DelimitedRow).cells.length;
    if (cells > MAX_RENDERED_CELLS) return i;
  }
  return cap;
}

/** How many colours the columns cycle through (the palette lives in styles.css). */
const COLUMN_COLORS = 8;

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

export interface DelimitedTableProps {
  relPath: string;
  content: string;
}

/**
 * CSV / TSV content as a table: one colour per column, numbers aligned right, and a
 * header click sorting the rows. Read-only, like the rest of the Viewer.
 */
export function DelimitedTable({ relPath, content }: DelimitedTableProps) {
  const { t } = useTranslation();
  const table = useMemo(
    () => readDelimited(relPath, content),
    [relPath, content],
  );
  const [sort, setSort] = useState<SortState | null>(null);
  const columns = table.header.length;
  // A file rewritten under the viewer can lose the sorted column.
  const activeSort = sort !== null && sort.column < columns ? sort : null;
  const rows = useMemo(
    () => sortRows(table.rows, table.numericColumns, activeSort),
    [table, activeSort],
  );

  if (table.header.length === 0) {
    return (
      <div className="delimited-empty" role="note">
        {t("viewer.tableEmpty")}
      </div>
    );
  }

  const shown = rows.slice(0, rowsWithinBudget(rows));
  // Focusable so the keys that scroll (arrows, PageDown) reach this scroll container: the
  // Viewer focuses it on open, as it focuses the editor for a text file.
  return (
    <div className="delimited-table" tabIndex={-1}>
      <table aria-label={t("viewer.tableLabel", { path: relPath })}>
        <thead>
          <tr>
            <th
              scope="col"
              className="delimited-rownum"
              aria-label={t("viewer.rowNumber")}
            />
            {table.header.map((name, column) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: a column is its position; header names may repeat
                key={column}
                scope="col"
                data-column={column % COLUMN_COLORS}
                className={
                  table.numericColumns[column] === true ? "is-numeric" : ""
                }
                aria-sort={
                  activeSort?.column === column
                    ? ARIA_SORT[activeSort.direction]
                    : "none"
                }
              >
                <button
                  type="button"
                  className="delimited-sort"
                  aria-label={t("viewer.sortByColumn", {
                    column: name === "" ? String(column + 1) : name,
                  })}
                  onClick={() => setSort((cur) => nextSort(cur, column))}
                >
                  <span className="delimited-name">{name}</span>
                  <span className="delimited-arrow" aria-hidden="true">
                    {activeSort?.column === column
                      ? activeSort.direction === "asc"
                        ? "▲"
                        : "▼"
                      : ""}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.line}>
              <th scope="row" className="delimited-rownum">
                {row.line}
              </th>
              {row.cells.map((cell, column) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: a column is its position; header names may repeat
                  key={column}
                  data-column={column % COLUMN_COLORS}
                  className={
                    table.numericColumns[column] === true ? "is-numeric" : ""
                  }
                  title={cell}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(shown.length < rows.length ||
        table.totalColumns > MAX_TABLE_COLUMNS) && (
        <p className="delimited-truncated" role="status">
          {shown.length < rows.length && (
            <span>
              {t("viewer.tableTruncated", {
                shown: shown.length.toLocaleString(),
                total: rows.length.toLocaleString(),
              })}
            </span>
          )}
          {table.totalColumns > MAX_TABLE_COLUMNS && (
            <span>
              {t("viewer.tableColumnsTruncated", {
                shown: MAX_TABLE_COLUMNS.toLocaleString(),
              })}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
