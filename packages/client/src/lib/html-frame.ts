const HTML_FRAME_PATH = "/html-frame.html";

/**
 * The page that shows a repo or dashboard HTML document with its scripts running, served by the
 * server under its own content policy (a `srcdoc` frame would inherit the cockpit's). It is
 * addressed by the server's other loopback name so the page never shares the app's origin, which
 * the desktop shell trusts with its commands.
 */
export function htmlFrameUrl(serverBase: string): string {
  const url = new URL(HTML_FRAME_PATH, serverBase);
  url.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
  return url.href;
}

/** Message type `t` of the message carrying the HTML; the page's inline script matches it. */
export const HTML_FRAME_RENDER = "html-frame.render";

export interface HtmlFrameRenderMessage {
  t: typeof HTML_FRAME_RENDER;
  html: string;
}
