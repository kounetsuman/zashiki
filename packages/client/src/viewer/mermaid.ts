import { diagramFrame } from "./diagram-frame.js";
import { probeMermaid } from "./mermaid-probe.js";

export interface RenderMermaidOptions {
  /** Sources of diagrams the user has asked to render even though they load remote content. */
  renderedRemoteDiagrams?: ReadonlySet<string>;
  /** Text of the button that stands in for a diagram loading content from these hosts. */
  remoteDiagramLabel?: (hosts: string) => string;
  /** Text on that button telling how to render the diagram anyway. */
  remoteDiagramAction?: string;
  /** Accessible name of the frame a diagram is shown in. */
  diagramTitle?: string;
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

function showCodeBlock(block: HTMLElement, source: string): void {
  block.dataset.mermaidState = "error";
  if (block.querySelector("code") !== null) return;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-mermaid";
  code.textContent = source;
  pre.append(code);
  block.replaceChildren(pre);
}

/**
 * Turns the `.viewer-mermaid` placeholders under `root` into rendered diagrams. Each diagram is
 * drawn where it cannot fetch anything from outside the app and shown in a frame that may load
 * nothing either. One found to reach outside the repo becomes a button naming the hosts instead,
 * unless its source is in `renderedRemoteDiagrams`, whose frame may load its remote images. A block that
 * fails to render shows its code block. Never rejects; safe to call on every commit — each block
 * is claimed synchronously, so concurrent calls don't process it twice.
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
    if (!block.isConnected) continue;
    const source = block.dataset.mermaidSource ?? "";
    const id = `viewer-mermaid-${crypto.randomUUID()}`;
    try {
      const result = await probeMermaid(id, source);
      if (!block.isConnected) continue;
      const approved = options.renderedRemoteDiagrams?.has(source) === true;
      if (result.kind === "remote" && approved) {
        if (result.svg === null) {
          showCodeBlock(block, source);
        } else {
          block.dataset.mermaidState = "rendered";
          block.replaceChildren(
            diagramFrame(
              result.svg,
              options.diagramTitle ?? "Mermaid",
              "remote",
            ),
          );
        }
      } else if (result.kind === "failed") {
        showCodeBlock(block, source);
      } else if (result.kind === "remote") {
        block.dataset.mermaidState = "remote";
        block.replaceChildren(remoteDiagramButton(result.hosts, options));
      } else {
        block.dataset.mermaidState = "rendered";
        block.replaceChildren(
          diagramFrame(result.svg, options.diagramTitle ?? "Mermaid"),
        );
      }
    } catch {
      if (!block.isConnected) continue;
      showCodeBlock(block, source);
    }
  }
}
