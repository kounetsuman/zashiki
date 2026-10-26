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

  it("opens web links in a new window, which the desktop app hands to the browser", () => {
    for (const source of [
      "[site](https://example.com/a)",
      "Visit https://example.com/b today",
      "[plain](http://example.com/c)",
      "[relative to the scheme](//example.com/d)",
    ]) {
      const html = renderMarkdown(source);
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    }
  });

  it("keeps in-document and relative links in place", () => {
    for (const source of ["[top](#heading)", "[next](./other.md)"]) {
      expect(renderMarkdown(source)).not.toContain("target=");
    }
  });

  it("does not emit raw HTML from the source", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
  });

  it("wraps a mermaid fence in a diagram placeholder keeping the source as a code block", () => {
    const html = renderMarkdown("```mermaid\ngraph TD;\n  A-->B;\n```");
    expect(html).toContain('class="viewer-mermaid"');
    expect(html).toContain('<code class="language-mermaid">');
    expect(html).toContain("graph TD;");
  });

  it("escapes HTML inside a mermaid fence", () => {
    const html = renderMarkdown(
      '```mermaid\ngraph TD;\n  A["<script>x</script>"]\n```',
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("leaves non-mermaid fences as plain code blocks", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```");
    expect(html).not.toContain("viewer-mermaid");
    expect(html).toContain('<code class="language-js">');
  });

  it("does not emit raw <img> HTML from the source", () => {
    const html = renderMarkdown('<img src="https://tracker.example/p.gif">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  describe("remote images", () => {
    it.each([
      ["https", "https://tracker.example/p.png", "tracker.example"],
      ["http", "http://tracker.example:8080/p.png", "tracker.example:8080"],
      ["protocol-relative", "//tracker.example/p.png", "tracker.example"],
      ["other scheme", "ftp://tracker.example/p.png", "tracker.example"],
      [
        "scheme without slashes",
        "http:tracker.example/p.png",
        "tracker.example",
      ],
    ])("renders a %s image as a load button without a src", (_, url, host) => {
      const html = renderMarkdown(`![a chart](${url})`);
      expect(html).not.toContain("<img");
      expect(html).not.toMatch(/\ssrc=/);
      expect(html).toContain('class="viewer-remote-image"');
      expect(html).toContain('type="button"');
      expect(html).toContain("a chart");
      expect(html).toContain(host);
    });

    it("keeps a remote image inside a link as a load button", () => {
      const html = renderMarkdown(
        "[![badge](https://img.example/b.svg)](https://ci.example)",
      );
      expect(html).not.toContain("<img");
      expect(html).toContain('class="viewer-remote-image"');
    });

    it("titles the load button with the given text for its host", () => {
      const html = renderMarkdown("![x](https://img.example/a.png)", {
        remoteImageLabel: (host) => `Load from ${host}`,
      });
      expect(html).toContain('title="Load from img.example"');
    });

    it("escapes the alt text and URL on the load button", () => {
      const html = renderMarkdown(
        '![<b>"q"</b>](https://img.example/a.png?x="1")',
      );
      expect(html).not.toContain("<b>");
      expect(html).not.toMatch(/data-remote-src="[^"]*"1"/);
    });

    it("renders a remote image as an img once its URL is loaded", () => {
      const src = "https://img.example/a.png";
      const html = renderMarkdown(`![a chart](${src})`, {
        loadedRemoteImages: new Set([src]),
      });
      expect(html).toContain(`<img src="${src}" alt="a chart">`);
      expect(html).not.toContain("viewer-remote-image");
    });

    it("leaves other remote images as buttons when one is loaded", () => {
      const html = renderMarkdown(
        "![a](https://img.example/a.png) ![b](https://img.example/b.png)",
        { loadedRemoteImages: new Set(["https://img.example/a.png"]) },
      );
      expect(html).toContain('<img src="https://img.example/a.png"');
      expect(html).toContain('data-remote-src="https://img.example/b.png"');
    });
  });

  describe("local images", () => {
    it.each([
      ["relative", "docs/shot.png"],
      ["dot-relative", "./shot.png"],
      ["root-relative", "/shot.png"],
      ["data", "data:image/png;base64,iVBORw0KGgo="],
    ])("renders a %s image as an img exactly as before", (_, url) => {
      const html = renderMarkdown(`![shot](${url})`);
      expect(html).toContain(`<img src="${url}" alt="shot">`);
      expect(html).not.toContain("viewer-remote-image");
    });
  });
});
