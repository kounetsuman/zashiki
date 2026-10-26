// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderMermaidBlocks } from "./mermaid.js";
import type { MermaidProbeResult } from "./mermaid-probe.js";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: "<svg data-diagram></svg>" })),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

const probe = vi.hoisted(() => ({
  probeMermaid: vi.fn(
    async (): Promise<MermaidProbeResult> => ({
      kind: "rendered",
      svg: "<svg data-diagram></svg>",
    }),
  ),
}));

vi.mock("./mermaid-probe.js", () => probe);

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
    probe.probeMermaid.mockImplementation(async () => ({
      kind: "rendered",
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
    expect(probe.probeMermaid).toHaveBeenCalledWith(
      expect.any(String),
      "graph TD;",
    );
  });

  it("keeps the code block visible when the diagram fails to render", async () => {
    probe.probeMermaid.mockImplementation(async () => ({ kind: "failed" }));
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
    expect(probe.probeMermaid).toHaveBeenCalledTimes(1);
  });

  it("skips blocks that were already processed", async () => {
    const host = previewWith(
      '<div class="viewer-mermaid" data-mermaid-state="rendered"><svg></svg></div>',
    );
    await renderMermaidBlocks(host);
    expect(probe.probeMermaid).not.toHaveBeenCalled();
  });

  it("renders every pending block in the preview", async () => {
    const host = previewWith(
      '<div class="viewer-mermaid"><pre><code>graph TD;</code></pre></div>' +
        '<div class="viewer-mermaid"><pre><code>sequenceDiagram</code></pre></div>',
    );
    await renderMermaidBlocks(host);
    expect(probe.probeMermaid).toHaveBeenCalledTimes(2);
    expect(
      host.querySelectorAll("[data-mermaid-state='rendered']"),
    ).toHaveLength(2);
  });

  describe("a diagram that loads remote content", () => {
    const source = 'flowchart TD\n  A@{ img: "https://img.example/a.png" }';
    const remoteBlock = `<div class="viewer-mermaid"><pre><code>${source}</code></pre></div>`;

    beforeEach(() => {
      probe.probeMermaid.mockImplementation(async () => ({
        kind: "remote",
        hosts: ["a.example", "b.example", "c.example", "d.example"],
      }));
    });

    it("becomes a button naming the hosts instead of the diagram", async () => {
      const host = previewWith(remoteBlock);
      await renderMermaidBlocks(host, {
        remoteDiagramLabel: (hosts) => `Loads from ${hosts}`,
        remoteDiagramAction: "Render",
      });
      const block = host.querySelector<HTMLElement>(".viewer-mermaid");
      expect(block?.dataset.mermaidState).toBe("remote");
      expect(block?.querySelector("svg")).toBeNull();
      const button = block?.querySelector("button.viewer-mermaid-remote");
      expect(button?.getAttribute("type")).toBe("button");
      expect(button?.textContent).toContain(
        "Loads from a.example, b.example, c.example, …",
      );
      expect(button?.textContent).toContain("Render");
      expect(mermaid.render).not.toHaveBeenCalled();
    });

    it("keeps its source once the button replaces the code block", async () => {
      const host = previewWith(remoteBlock);
      await renderMermaidBlocks(host);
      const block = host.querySelector<HTMLElement>(".viewer-mermaid");
      expect(block?.dataset.mermaidSource).toBe(source);
    });

    it("is drawn in the app without probing once the user asked to render it", async () => {
      const host = previewWith(remoteBlock);
      await renderMermaidBlocks(host, {
        renderedRemoteDiagrams: new Set([source]),
      });
      const block = host.querySelector<HTMLElement>(".viewer-mermaid");
      expect(block?.dataset.mermaidState).toBe("rendered");
      expect(block?.querySelector("svg[data-diagram]")).not.toBeNull();
      expect(probe.probeMermaid).not.toHaveBeenCalled();
      expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), source);
    });

    it("shows the code block when the probe page cannot start", async () => {
      probe.probeMermaid.mockImplementation(async () => {
        throw new Error("no probe page");
      });
      const host = previewWith(remoteBlock);
      await renderMermaidBlocks(host);
      const block = host.querySelector<HTMLElement>(".viewer-mermaid");
      expect(block?.dataset.mermaidState).toBe("error");
      expect(block?.querySelector("button")).toBeNull();
    });
  });
});
