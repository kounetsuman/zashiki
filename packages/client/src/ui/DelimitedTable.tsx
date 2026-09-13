import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  nextSort,
  readDelimited,
  type SortState,
  sortRows,
} from "../viewer/delimited.js";

/** Rows past this one are left out: a whole large file in the DOM stalls the cockpit. */
export const MAX_RENDERED_ROWS = 2000;

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
  // A file rewritten under the viewer can lose the sorted column.
  const activeSort =
    sort !== null && sort.column < table.header.length ? sort : null;
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

  const shown = rows.slice(0, MAX_RENDERED_ROWS);
  return (
    <div className="delimited-table">
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
      {shown.length < rows.length && (
        <p className="delimited-truncated" role="status">
          {t("viewer.tableTruncated", {
            shown: shown.length.toLocaleString(),
            total: rows.length.toLocaleString(),
          })}
        </p>
      )}
    </div>
  );
}
