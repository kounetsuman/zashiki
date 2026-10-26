/** The app's global rules a diagram inherits, so it measures and draws as it would in the app. */
export const DIAGRAM_BASE_CSS = `* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
  font-size: 13px;
}`;

const PREVIEW_CSS = `html, body { overflow: hidden; background: transparent; }
body { color: #ddd; }
body > svg { display: block; width: 100%; height: auto; }`;

const FRAME_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** A page holding only the diagram, whose policy lets it load nothing from outside, ever. */
export function diagramFrameDocument(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(
    FRAME_POLICY,
  )}"><style>${DIAGRAM_BASE_CSS}\n${PREVIEW_CSS}</style></head><body>${svg}</body></html>`;
}

export interface DiagramFrameSize {
  /** CSS `max-width`, or null to fill the preview. */
  maxWidth: string | null;
  /** CSS `aspect-ratio`, or null when the drawing has no proportions to keep. */
  aspectRatio: string | null;
  /** CSS `height` for a drawing of fixed height. */
  height: string | null;
}

function pixels(value: string | null): number | null {
  if (value === null || !/^\s*[\d.]+(px)?\s*$/.test(value)) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** How large the frame must be to show the drawing as the SVG itself asks to be shown. */
export function diagramFrameSize(svg: string): DiagramFrameSize {
  const element = new DOMParser()
    .parseFromString(svg, "text/html")
    .querySelector("svg");
  const size: DiagramFrameSize = {
    maxWidth: null,
    aspectRatio: null,
    height: null,
  };
  if (element === null) return size;
  const width = pixels(element.getAttribute("width"));
  const height = pixels(element.getAttribute("height"));
  const [, , boxWidth, boxHeight] = (element.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const maxWidth = pixels(element.style.maxWidth || null);
  if (maxWidth !== null) size.maxWidth = `${maxWidth}px`;
  else if (width !== null) size.maxWidth = `${width}px`;
  if (
    boxWidth !== undefined &&
    boxHeight !== undefined &&
    boxWidth > 0 &&
    boxHeight > 0
  ) {
    size.aspectRatio = `${boxWidth} / ${boxHeight}`;
  } else if (width !== null && height !== null) {
    size.aspectRatio = `${width} / ${height}`;
  } else if (height !== null) {
    size.height = `${height}px`;
  }
  return size;
}

/**
 * Shows a drawn diagram in a frame of its own that runs no script and may fetch nothing, so
 * whatever the diagram refers to stays unloaded. The frame takes neither focus nor the pointer,
 * so the app's keys keep working and nothing in the read-only diagram can be followed.
 */
export function diagramFrame(svg: string, title: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "viewer-mermaid-frame";
  frame.setAttribute("sandbox", "");
  frame.title = title;
  frame.tabIndex = -1;
  frame.style.pointerEvents = "none";
  frame.srcdoc = diagramFrameDocument(svg);
  const { maxWidth, aspectRatio, height } = diagramFrameSize(svg);
  if (maxWidth !== null) frame.style.maxWidth = maxWidth;
  if (aspectRatio !== null) frame.style.aspectRatio = aspectRatio;
  if (height !== null) frame.style.height = height;
  return frame;
}
