import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders GFM tables as a table element", () => {
    const html = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders an unchecked task list item as a disabled unchecked checkbox", () => {
    const html = renderMarkdown("- [ ] todo");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("checked");
    expect(html).not.toContain("[ ]");
    expect(html).toContain("todo");
  });

  it("renders a checked task list item as a disabled checked checkbox", () => {
    const html = renderMarkdown("- [x] done");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).not.toContain("[x]");
    expect(html).toContain("done");
  });

  it("tags task list items so their bullet marker can be hidden", () => {
    const html = renderMarkdown("- [ ] a\n- [x] b");
    expect(html).toContain("task-list-item");
  });

  it("leaves ordinary list items untouched", () => {
    const html = renderMarkdown("- plain\n- [not a task] still text");
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("[not a task] still text");
  });

  it("resolves reference-style links and hides their definitions", () => {
    const html = renderMarkdown("See [v1].\n\n[v1]: https://example.com/v1");
    expect(html).toContain('href="https://example.com/v1"');
    expect(html).not.toContain("]: https");
  });

  it("does not emit raw HTML from the source", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
  });
});
