/**
 * The page that shows a repo or dashboard HTML document with its scripts running. It is served
 * under its own content policy, unlike a `srcdoc` frame, which would inherit the cockpit's.
 */
export const HTML_FRAME_PAGE = "/html-frame.html";

/** Message type `t` of the message carrying the HTML; the page's inline script matches it. */
export const HTML_FRAME_RENDER = "html-frame.render";

export interface HtmlFrameRenderMessage {
  t: typeof HTML_FRAME_RENDER;
  html: string;
}
