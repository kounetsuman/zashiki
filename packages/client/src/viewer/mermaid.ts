import type { Mermaid } from "mermaid";

let mermaidReady: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidReady ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: "dark" });
    return mermaid;
  });
  return mermaidReady;
}

/**
 * Turns the `.viewer-mermaid` placeholders under `root` into rendered SVG
 * diagrams. Mermaid is imported on first use so it stays out of the main
 * bundle. A block that fails to render keeps its code block as the visible
 * fallback. Never rejects; safe to call on every commit — each block is
 * claimed synchronously, so concurrent calls don't process it twice.
 */
export async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(
      ".viewer-mermaid:not([data-mermaid-state])",
    ),
  );
  if (blocks.length === 0) return;
  for (const block of blocks) block.dataset.mermaidState = "pending";

  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    // Retry the import on the next call; the code blocks stay visible.
    mermaidReady = undefined;
    for (const block of blocks) block.dataset.mermaidState = "error";
    return;
  }

  for (const block of blocks) {
    const source = block.querySelector("code")?.textContent ?? "";
    const id = `viewer-mermaid-${crypto.randomUUID()}`;
    try {
      const { svg } = await mermaid.render(id, source);
      if (!block.isConnected) continue;
      block.dataset.mermaidState = "rendered";
      // Mermaid sanitizes its SVG output (securityLevel defaults to strict).
      block.innerHTML = svg;
    } catch {
      // A failed render can leave mermaid's scratch elements behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (!block.isConnected) continue;
      block.dataset.mermaidState = "error";
    }
  }
}
