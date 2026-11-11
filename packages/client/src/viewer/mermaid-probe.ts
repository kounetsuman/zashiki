export type MermaidProbeResult =
  | { kind: "rendered"; svg: string }
  /** `svg` is the drawing with its remote content left unloaded, or null when none was drawn. */
  | { kind: "remote"; hosts: string[]; svg: string | null }
  | { kind: "failed" };

export interface MermaidProbeWindow {
  probeMermaid(id: string, source: string): Promise<MermaidProbeResult>;
}

/** Loads nothing from outside the app, so whatever a diagram reaches for shows up as refused. */
const PROBE_PAGE = "/mermaid-probe.html";
/** Also loads remote images: a diagram can only be laid out around images it can measure. */
const REMOTE_RENDER_PAGE = "/mermaid-render.html";

const pagesReady = new Map<string, Promise<MermaidProbeWindow>>();
let queue: Promise<unknown> = Promise.resolve();

function openDrawingFrame(page: string): Promise<MermaidProbeWindow> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.className = "viewer-mermaid-probe";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.src = page;
    frame.addEventListener("load", () => {
      const probe =
        frame.contentWindow as unknown as Partial<MermaidProbeWindow> | null;
      if (typeof probe?.probeMermaid === "function") {
        resolve(probe as MermaidProbeWindow);
      } else {
        frame.remove();
        reject(new Error("the Mermaid drawing page did not start"));
      }
    });
    frame.addEventListener("error", () => {
      frame.remove();
      reject(new Error("the Mermaid drawing page did not load"));
    });
    document.body.appendChild(frame);
  });
}

/** Draws in `page`, one diagram at a time, since a page tells requests apart by the drawing running. */
function drawIn(
  page: string,
  id: string,
  source: string,
): Promise<MermaidProbeResult> {
  const run = async () => {
    let ready = pagesReady.get(page);
    if (ready === undefined) {
      ready = openDrawingFrame(page);
      pagesReady.set(page, ready);
    }
    let probe: MermaidProbeWindow;
    try {
      probe = await ready;
    } catch (error) {
      pagesReady.delete(page);
      throw error;
    }
    return probe.probeMermaid(id, source);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

/**
 * Renders a diagram in a page whose content policy lets it fetch nothing from outside the app,
 * and tells whether the drawing or the result reaches outside the repo.
 */
export function probeMermaid(
  id: string,
  source: string,
): Promise<MermaidProbeResult> {
  return drawIn(PROBE_PAGE, id, source);
}

/**
 * Renders a diagram the user chose to show with its remote images in a page of its own that may
 * load them, so the cockpit's document never does.
 */
export function renderRemoteMermaid(
  id: string,
  source: string,
): Promise<MermaidProbeResult> {
  return drawIn(REMOTE_RENDER_PAGE, id, source);
}
