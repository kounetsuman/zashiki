// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderMermaidBlocks } from "./mermaid.js";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: "<svg data-diagram></svg>" })),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

function previewWith(blocks: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = blocks;
  document.body.appendChild(host);
  return host;
}

describe("renderMermaidBlocks", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    mermaid.render.mockImplementation(async () => ({
      svg: "<svg data-diagram></svg>",
    }));
  });

  it("replaces a pending block with the rendered svg", async () => {
    const host = previewWith(
      '<div class="viewer-mermaid"><pre><code class="language-mermaid">graph TD;</code></pre></div>',
    );
    await renderMermaidBlocks(host);
    const block = host.querySelector<HTMLElement>(".viewer-mermaid");
    expect(block?.dataset.mermaidState).toBe("rendered");
    expect(block?.querySelector("svg[data-diagram]")).not.toBeNull();
    expect(block?.querySelector("code")).toBeNull();
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.any(String),
      "graph TD;",
    );
  });

  it("keeps the code block visible when the diagram fails to render", async () => {
    mermaid.render.mockImplementation(async () => {
      throw new Error("parse error");
    });
    const host = previewWith(
      '<div class="viewer-mermaid"><pre><code class="language-mermaid">not a diagram</code></pre></div>',
    );
    await renderMermaidBlocks(host);
    const block = host.querySelector<HTMLElement>(".viewer-mermaid");
    expect(block?.dataset.mermaidState).toBe("error");
    expect(block?.textContent).toContain("not a diagram");
  });

  it("claims blocks synchronously so concurrent calls render each block once", async () => {
    const host = previewWith(
      '<div class="viewer-mermaid"><pre><code>graph TD;</code></pre></div>',
    );
    await Promise.all([renderMermaidBlocks(host), renderMermaidBlocks(host)]);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("skips blocks that were already processed", async () => {
    const host = previewWith(
      '<div class="viewer-mermaid" data-mermaid-state="rendered"><svg></svg></div>',
    );
    await renderMermaidBlocks(host);
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("renders every pending block in the preview", async () => {
    const host = previewWith(
      '<div class="viewer-mermaid"><pre><code>graph TD;</code></pre></div>' +
        '<div class="viewer-mermaid"><pre><code>sequenceDiagram</code></pre></div>',
    );
    await renderMermaidBlocks(host);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(
      host.querySelectorAll("[data-mermaid-state='rendered']"),
    ).toHaveLength(2);
  });
});
