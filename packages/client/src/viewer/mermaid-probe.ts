export type MermaidProbeResult =
  | { kind: "rendered"; svg: string }
  | { kind: "remote"; hosts: string[] }
  | { kind: "failed" };

export interface MermaidProbeWindow {
  probeMermaid(id: string, source: string): Promise<MermaidProbeResult>;
}

const PROBE_PAGE = "/mermaid-probe.html";

let probeReady: Promise<MermaidProbeWindow> | undefined;
let queue: Promise<unknown> = Promise.resolve();

function openProbeFrame(): Promise<MermaidProbeWindow> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.className = "viewer-mermaid-probe";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.src = PROBE_PAGE;
    frame.addEventListener("load", () => {
      const probe =
        frame.contentWindow as unknown as Partial<MermaidProbeWindow> | null;
      if (typeof probe?.probeMermaid === "function") {
        resolve(probe as MermaidProbeWindow);
      } else {
        frame.remove();
        reject(new Error("the Mermaid probe page did not start"));
      }
    });
    frame.addEventListener("error", () => {
      frame.remove();
      reject(new Error("the Mermaid probe page did not load"));
    });
    document.body.appendChild(frame);
  });
}

/**
 * Renders a diagram in a page whose content policy lets it fetch nothing from outside the app,
 * and returns its SVG only when neither the drawing nor the result reaches outside the repo.
 * Probes run one at a time, since the page tells requests apart by the probe that is running.
 */
export function probeMermaid(
  id: string,
  source: string,
): Promise<MermaidProbeResult> {
  const run = async () => {
    probeReady ??= openProbeFrame();
    let probe: MermaidProbeWindow;
    try {
      probe = await probeReady;
    } catch (error) {
      probeReady = undefined;
      throw error;
    }
    return probe.probeMermaid(id, source);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
