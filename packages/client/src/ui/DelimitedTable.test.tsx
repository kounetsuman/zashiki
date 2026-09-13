// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DelimitedTable, MAX_RENDERED_ROWS } from "./DelimitedTable.js";

const CSV = "name,size\nitem10,2\nitem2,10\nitem1,\n";

afterEach(cleanup);

/** The visible cells of each body row, without the row-number header cell. */
function bodyRows(): string[][] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    );
}

function sortBy(column: string): void {
  fireEvent.click(screen.getByRole("button", { name: `${column} で並べ替え` }));
}

describe("DelimitedTable", () => {
  it("renders the first record as the header and the rest as rows", () => {
    render(<DelimitedTable relPath="a.csv" content={CSV} />);
    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers.join(" ")).toContain("name");
    expect(headers.join(" ")).toContain("size");
    expect(bodyRows()).toEqual([
      ["item10", "2"],
      ["item2", "10"],
      ["item1", ""],
    ]);
  });

  it("numbers the rows by their line in the file, header included", () => {
    render(<DelimitedTable relPath="a.csv" content={CSV} />);
    const numbers = screen.getAllByRole("rowheader").map((h) => h.textContent);
    expect(numbers).toEqual(["2", "3", "4"]);
  });

  it("cycles a column through ascending, descending and the file order", () => {
    render(<DelimitedTable relPath="a.csv" content={CSV} />);
    sortBy("size");
    expect(bodyRows().map((r) => r[1])).toEqual(["2", "10", ""]);
    sortBy("size");
    expect(bodyRows().map((r) => r[1])).toEqual(["10", "2", ""]);
    sortBy("size");
    expect(bodyRows().map((r) => r[0])).toEqual(["item10", "item2", "item1"]);
  });

  it("reports the sort direction to assistive technology", () => {
    render(<DelimitedTable relPath="a.csv" content={CSV} />);
    const columnOf = (name: string) =>
      screen.getByRole("columnheader", { name: new RegExp(name) });
    expect(columnOf("size").getAttribute("aria-sort")).toBe("none");
    sortBy("size");
    expect(columnOf("size").getAttribute("aria-sort")).toBe("ascending");
    sortBy("size");
    expect(columnOf("size").getAttribute("aria-sort")).toBe("descending");
  });

  // Queried through the DOM rather than by role: resolving roles for thousands of rows is
  // slow enough to time the test out under a loaded suite.
  it("renders up to the row cap and says how much of the file is shown", () => {
    const total = MAX_RENDERED_ROWS + 5;
    const content = `n\n${Array.from({ length: total }, (_, i) => i + 1).join("\n")}\n`;
    const { container } = render(
      <DelimitedTable relPath="big.csv" content={content} />,
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(
      MAX_RENDERED_ROWS,
    );
    const notice = container.querySelector(".delimited-truncated");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain(total.toLocaleString());
  });

  it("says nothing about truncation when the whole file is shown", () => {
    render(<DelimitedTable relPath="a.csv" content={CSV} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a message instead of an empty grid when the file has no records", () => {
    render(<DelimitedTable relPath="a.csv" content="" />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("note").textContent).not.toBe("");
  });
});
