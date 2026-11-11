import { useEffect, useRef } from "react";

import {
  HTML_FRAME_RENDER,
  type HtmlFrameRenderMessage,
  htmlFrameUrl,
} from "../lib/html-frame.js";
import { serverBase } from "../lib/server-base.js";

export interface HtmlFrameProps {
  html: string;
  title: string;
  className?: string;
}

/**
 * Shows an HTML document with its scripts running. allow-scripts without allow-same-origin keeps
 * the page in an opaque origin, so it cannot reach the app's token, API, or storage, open popups,
 * or navigate the app. The HTML goes to the host page by message rather than `srcdoc`, which
 * would subject the page to the cockpit's script policy.
 */
export function HtmlFrame({ html, title, className }: HtmlFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = ref.current;
    if (frame === null) return;
    const handOver = () => {
      const message: HtmlFrameRenderMessage = { t: HTML_FRAME_RENDER, html };
      // An opaque origin matches no target origin but "*"; the HTML is what the frame shows anyway.
      frame.contentWindow?.postMessage(message, "*");
    };
    frame.addEventListener("load", handOver, { once: true });
    frame.src = htmlFrameUrl(serverBase());
    return () => frame.removeEventListener("load", handOver);
  }, [html]);

  return (
    <iframe
      ref={ref}
      className={className}
      title={title}
      sandbox="allow-scripts"
    />
  );
}
