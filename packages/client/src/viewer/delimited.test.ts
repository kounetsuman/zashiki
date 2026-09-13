import { describe, expect, it } from "vitest";

import {
  isDelimitedText,
  MAX_TABLE_COLUMNS,
  nextSort,
  readDelimited,
  sortRows,
} from "./delimited.js";

const cellsOf = (table: ReturnType<typeof readDelimited>) =>
  table.rows.map((r) => r.cells);

describe("isDelimitedText", () => {
  it("accepts the delimited-text extensions", () => {
    expect(isDelimitedText("data/report.csv")).toBe(true);
    expect(isDelimitedText("data/report.TSV")).toBe(true);
    expect(isDelimitedText("data/report.tab")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isDelimitedText("src/app.ts")).toBe(false);
    expect(isDelimitedText("notes.md")).toBe(false);
    expect(isDelimitedText("csv")).toBe(false);
  });
});

describe("readDelimited", () => {
  it("splits a comma file into a header and rows", () => {
    const table = readDelimited("a.csv", "name,age\nada,36\nalan,41\n");
    expect(table.header).toEqual(["name", "age"]);
    expect(cellsOf(table)).toEqual([
      ["ada", "36"],
      ["alan", "41"],
    ]);
    expect(table.rows.map((r) => r.line)).toEqual([2, 3]);
  });

  it("keeps a quoted field's delimiters, newlines and escaped quotes", () => {
    const table = readDelimited(
      "a.csv",
      'name,note\n"lovelace, ada","said ""hi""\nagain"\n',
    );
    expect(cellsOf(table)).toEqual([["lovelace, ada", 'said "hi"\nagain']]);
  });

  it("reads a tab file on tabs, leaving quotes as literal text", () => {
    const table = readDelimited("a.tsv", 'name\tnote\nada\t"quoted"\n');
    expect(table.delimiter).toBe("\t");
    expect(cellsOf(table)).toEqual([["ada", '"quoted"']]);
  });

  it("detects a semicolon-delimited csv", () => {
    const table = readDelimited("a.csv", "name;age\nada;36\n");
    expect(table.delimiter).toBe(";");
    expect(table.header).toEqual(["name", "age"]);
  });

  it("detects the delimiter the rows agree on, not the one in the first line", () => {
    const table = readDelimited("a.csv", "id\n1;2;3\n4;5;6\n");
    expect(table.delimiter).toBe(";");
    expect(cellsOf(table)).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("keeps a semicolon file semicolon-delimited when its text holds commas", () => {
    const table = readDelimited(
      "a.csv",
      "name;desc\nada;hello, world\nalan;bye, now\n",
    );
    expect(table.delimiter).toBe(";");
    expect(table.header).toEqual(["name", "desc"]);
    expect(cellsOf(table)).toEqual([
      ["ada", "hello, world"],
      ["alan", "bye, now"],
    ]);
  });

  it("stays comma-delimited when a comma file quotes semicolons in its text", () => {
    const table = readDelimited("a.csv", 'name,desc\nada,"p;q"\nalan,"r;s"\n');
    expect(table.delimiter).toBe(",");
    expect(cellsOf(table)).toEqual([
      ["ada", "p;q"],
      ["alan", "r;s"],
    ]);
  });

  it("leaves a single column alone when one line happens to hold a semicolon", () => {
    const table = readDelimited(
      "a.csv",
      "note\nalpha\nbeta; gamma\ndelta\nepsilon\n",
    );
    expect(table.delimiter).toBe(",");
    expect(table.header).toEqual(["note"]);
    expect(cellsOf(table)).toEqual([
      ["alpha"],
      ["beta; gamma"],
      ["delta"],
      ["epsilon"],
    ]);
  });

  it("prefers the delimiter splitting further when both fit every record", () => {
    const table = readDelimited(
      "a.csv",
      "id;last, first;city\n1;Sato, K;Tokyo\n2;Doe, J;Osaka\n",
    );
    expect(table.delimiter).toBe(";");
    expect(table.header).toEqual(["id", "last, first", "city"]);
  });

  it("detects the delimiter of an export whose rows hold different column counts", () => {
    const table = readDelimited("a.csv", "a;b\n1;2;3\n4;5\n6;7;8\n9;10\n");
    expect(table.delimiter).toBe(";");
    expect(table.header).toEqual(["a", "b", ""]);
    expect(cellsOf(table)[0]).toEqual(["1", "2", "3"]);
  });

  it("keeps a ragged semicolon export off the commas written in its names", () => {
    const table = readDelimited(
      "a.csv",
      "id;name;city\n1;Sato, K;Tokyo\n2;Doe, J\n3;Roe, M;Osaka\n4;Poe, L;Kyoto\n",
    );
    expect(table.delimiter).toBe(";");
    expect(table.header).toEqual(["id", "name", "city"]);
  });

  it("keeps that export on its delimiter when the header too holds a comma", () => {
    const table = readDelimited(
      "a.csv",
      "id;name, full;city\n1;Sato, K;Tokyo\n2;Doe, J\n3;Roe, M;Osaka\n4;Poe, L;Kyoto\n",
    );
    expect(table.delimiter).toBe(";");
    expect(table.header).toEqual(["id", "name, full", "city"]);
  });

  it("leaves a two-line file alone when only its second line holds a semicolon", () => {
    expect(readDelimited("a.csv", "note\nalpha; beta\n").delimiter).toBe(",");
    expect(readDelimited("a.csv", "note\nalpha\tbeta\n").delimiter).toBe(",");
  });

  it("leaves a column of prose alone when half its lines hold a semicolon", () => {
    const lines = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? `alpha${i}; beta` : `plain${i}`,
    );
    const table = readDelimited("a.csv", `note\n${lines.join("\n")}\n`);
    expect(table.delimiter).toBe(",");
    expect(table.header).toEqual(["note"]);
  });

  it("numbers rows by their line in the file, across blank lines and quoted newlines", () => {
    const table = readDelimited("a.csv", 'h,note\na,"one\ntwo"\n\nb,plain\n');
    expect(table.rows.map((r) => r.line)).toEqual([2, 5]);
  });

  it("keeps a quoted empty record, and skips blank lines", () => {
    const table = readDelimited("a.csv", 'h\na\n\n""\nb\n');
    expect(cellsOf(table)).toEqual([["a"], [""], ["b"]]);
  });

  it("normalizes CRLF inside a quoted field", () => {
    const table = readDelimited("a.csv", 'h\r\n"one\r\ntwo"\r\n');
    expect(cellsOf(table)).toEqual([["one\ntwo"]]);
  });

  it("handles CRLF line endings and a byte order mark", () => {
    const table = readDelimited("a.csv", "﻿name,age\r\nada,36\r\n");
    expect(table.header).toEqual(["name", "age"]);
    expect(cellsOf(table)).toEqual([["ada", "36"]]);
  });

  it("names one header cell per column, whatever the rows hold", () => {
    const table = readDelimited("a.csv", "a,b\n1\n2,3,4\n");
    expect(table.header).toEqual(["a", "b", ""]);
    expect(table.totalColumns).toBe(3);
    expect(cellsOf(table)).toEqual([["1"], ["2", "3", "4"]]);
  });

  it("caps a record far wider than the rest, and leaves the others their own cells", () => {
    const wide = Array.from({ length: MAX_TABLE_COLUMNS + 50 }, (_, i) =>
      String(i),
    ).join(",");
    const table = readDelimited("a.csv", `a,b\n1,2\n3,4\n${wide}\n`);
    expect(table.header).toHaveLength(MAX_TABLE_COLUMNS);
    expect(table.totalColumns).toBe(MAX_TABLE_COLUMNS + 50);
    expect(table.rows.at(-1)?.cells).toHaveLength(MAX_TABLE_COLUMNS);
    expect(table.rows[0]?.cells).toEqual(["1", "2"]);
  });

  it("never lets a row hold more cells than the header names", () => {
    const table = readDelimited("a.csv", "a,b,c\n1,2,3\n4,5,6\n7,8,9,10,11\n");
    expect(table.header).toHaveLength(5);
    for (const row of table.rows)
      expect(row.cells.length).toBeLessThanOrEqual(table.header.length);
  });

  it("reads on past a quote that never closes, as plain text from that record", () => {
    const table = readDelimited("a.csv", 'a,b\n1,"oops\n2,x\n3,y\n');
    expect(table.rows.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(cellsOf(table).at(-1)).toEqual(["3", "y"]);
  });

  it("leaves a long identifier column to the text comparison", () => {
    const table = readDelimited(
      "a.csv",
      "id\n9007199254740993\n9007199254740992\n",
    );
    expect(table.numericColumns).toEqual([false]);
    const sorted = sortRows(table.rows, table.numericColumns, {
      column: 0,
      direction: "asc",
    });
    expect(sorted.map((r) => r.cells[0])).toEqual([
      "9007199254740992",
      "9007199254740993",
    ]);
  });

  it("has no rows for a header-only or empty file", () => {
    expect(readDelimited("a.csv", "a,b\n").rows).toEqual([]);
    expect(readDelimited("a.csv", "").header).toEqual([]);
    expect(readDelimited("a.csv", "").rows).toEqual([]);
  });

  it("reads a quoted grouped number as a number in a comma file", () => {
    const table = readDelimited("a.csv", 'id,amount\n1,"1,250"\n2,"950"\n');
    expect(table.numericColumns).toEqual([true, true]);
    const sorted = sortRows(table.rows, table.numericColumns, {
      column: 1,
      direction: "asc",
    });
    expect(sorted.map((r) => r.cells[1])).toEqual(["950", "1,250"]);
  });

  it("treats a grouped or comma-decimal number as text, not a number", () => {
    const table = readDelimited(
      "a.csv",
      "item;price\nwidget;1,250\nbolt;950\n",
    );
    expect(table.numericColumns).toEqual([false, false]);
  });

  it("marks a column numeric only when every filled cell is a number", () => {
    const table = readDelimited(
      "a.csv",
      "n,mixed,empty\n-1.5e3,1,\n42,x,\n,,\n",
    );
    expect(table.numericColumns).toEqual([true, false, false]);
  });
});

describe("sortRows", () => {
  const table = readDelimited(
    "a.csv",
    "name,size\nitem10,2\nitem2,10\nitem1,\n",
  );

  it("returns the original order when nothing is sorted", () => {
    expect(sortRows(table.rows, table.numericColumns, null)).toEqual(
      table.rows,
    );
  });

  it("compares a numeric column by value, not as text", () => {
    const sorted = sortRows(table.rows, table.numericColumns, {
      column: 1,
      direction: "asc",
    });
    expect(sorted.map((r) => r.cells[1])).toEqual(["2", "10", ""]);
  });

  it("keeps empty cells last in both directions", () => {
    const desc = sortRows(table.rows, table.numericColumns, {
      column: 1,
      direction: "desc",
    });
    expect(desc.map((r) => r.cells[1])).toEqual(["10", "2", ""]);
  });

  it("compares a text column naturally", () => {
    const sorted = sortRows(table.rows, table.numericColumns, {
      column: 0,
      direction: "asc",
    });
    expect(sorted.map((r) => r.cells[0])).toEqual(["item1", "item2", "item10"]);
  });

  it("breaks ties by the original row order", () => {
    const tied = readDelimited("a.csv", "k,v\nb,1\na,1\nc,1\n");
    const sorted = sortRows(tied.rows, tied.numericColumns, {
      column: 1,
      direction: "desc",
    });
    expect(sorted.map((r) => r.line)).toEqual([2, 3, 4]);
  });

  it("leaves the rows untouched", () => {
    const before = table.rows.map((r) => r.line);
    sortRows(table.rows, table.numericColumns, { column: 0, direction: "asc" });
    expect(table.rows.map((r) => r.line)).toEqual(before);
  });
});

describe("nextSort", () => {
  it("cycles a column ascending, descending, then back to the file order", () => {
    expect(nextSort(null, 2)).toEqual({ column: 2, direction: "asc" });
    expect(nextSort({ column: 2, direction: "asc" }, 2)).toEqual({
      column: 2,
      direction: "desc",
    });
    expect(nextSort({ column: 2, direction: "desc" }, 2)).toBeNull();
  });

  it("starts ascending when a different column is picked", () => {
    expect(nextSort({ column: 2, direction: "desc" }, 0)).toEqual({
      column: 0,
      direction: "asc",
    });
  });
});
