import type { Mermaid } from "mermaid";

import { MERMAID_CONFIG } from "./mermaid-config.js";
import { probeMermaid } from "./mermaid-probe.js";

let mermaidReady: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidReady ??= import("mermaid").then(
    ({ default: mermaid }) => {
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    },
    (error: unknown) => {
      mermaidReady = undefined;
      throw error;
    },
  );
  return mermaidReady;
}

export interface RenderMermaidOptions {
  /** Sources of diagrams the user has asked to render even though they load remote content. */
  renderedRemoteDiagrams?: ReadonlySet<string>;
  /** Text of the button that stands in for a diagram loading content from these hosts. */
  remoteDiagramLabel?: (hosts: string) => string;
  /** Text on that button telling how to render the diagram anyway. */
  remoteDiagramAction?: string;
}

const MAX_LISTED_HOSTS = 3;

function listedHosts(hosts: string[]): string {
  const listed = hosts.slice(0, MAX_LISTED_HOSTS).join(", ");
  return hosts.length > MAX_LISTED_HOSTS ? `${listed}, …` : listed;
}

function remoteDiagramButton(
  hosts: string[],
  options: RenderMermaidOptions,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "viewer-mermaid-remote";
  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "account_tree";
  const label = document.createElement("span");
  label.className = "viewer-mermaid-remote-label";
  const listed = listedHosts(hosts);
  label.textContent = options.remoteDiagramLabel?.(listed) ?? listed;
  button.append(icon, label);
  if (options.remoteDiagramAction !== undefined) {
    const action = document.createElement("span");
    action.className = "viewer-mermaid-remote-action";
    action.textContent = options.remoteDiagramAction;
    button.append(action);
  }
  return button;
}

async function renderInApp(id: string, source: string): Promise<string> {
  const mermaid = await loadMermaid();
  try {
    return (await mermaid.render(id, source)).svg;
  } catch (error) {
    // A failed render can leave mermaid's scratch elements behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    throw error;
  }
}

/**
 * Turns the `.viewer-mermaid` placeholders under `root` into rendered SVG diagrams. Each diagram
 * is first drawn where it cannot fetch anything from outside the app; one that reaches outside the
 * repo becomes a button naming the hosts instead, unless its source is in
 * `renderedRemoteDiagrams`, which is drawn in the app as is. A block that fails to render keeps
 * its code block as the visible fallback. Never rejects; safe to call on every commit — each
 * block is claimed synchronously, so concurrent calls don't process it twice.
 */
export async function renderMermaidBlocks(
  root: HTMLElement,
  options: RenderMermaidOptions = {},
): Promise<void> {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(
      ".viewer-mermaid:not([data-mermaid-state])",
    ),
  );
  for (const block of blocks) {
    block.dataset.mermaidState = "pending";
    block.dataset.mermaidSource ??=
      block.querySelector("code")?.textContent ?? "";
  }

  for (const block of blocks) {
    const source = block.dataset.mermaidSource ?? "";
    const id = `viewer-mermaid-${crypto.randomUUID()}`;
    try {
      const result = options.renderedRemoteDiagrams?.has(source)
        ? { kind: "rendered" as const, svg: await renderInApp(id, source) }
        : await probeMermaid(id, source);
      if (!block.isConnected) continue;
      if (result.kind === "failed") {
        block.dataset.mermaidState = "error";
      } else if (result.kind === "remote") {
        block.dataset.mermaidState = "remote";
        block.replaceChildren(remoteDiagramButton(result.hosts, options));
      } else {
        block.dataset.mermaidState = "rendered";
        // Mermaid sanitizes its SVG output (securityLevel defaults to strict).
        block.innerHTML = result.svg;
      }
    } catch {
      if (!block.isConnected) continue;
      block.dataset.mermaidState = "error";
    }
  }
}
