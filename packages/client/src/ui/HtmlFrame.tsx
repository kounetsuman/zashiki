import { useEffect, useRef } from "react";

import {
  HTML_FRAME_READY,
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

function isReadyMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { t?: unknown }).t === HTML_FRAME_READY
  );
}

/**
 * Shows an HTML document with its scripts running. allow-scripts without allow-same-origin keeps
 * the page in an opaque origin, so it cannot reach the app's token, API, or storage, open popups,
 * or navigate the app. The HTML goes to the host page by message rather than `srcdoc`, which
 * would subject the page to the cockpit's script policy, and is sent whenever the host page
 * loads, so a page that reloads itself is drawn again.
 */
export function HtmlFrame({ html, title, className }: HtmlFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const htmlRef = useRef(html);

  useEffect(() => {
    const answerReady = (event: MessageEvent) => {
      const frameWindow = ref.current?.contentWindow;
      if (frameWindow == null || event.source !== frameWindow) return;
      if (!isReadyMessage(event.data)) return;
      const message: HtmlFrameRenderMessage = {
        t: HTML_FRAME_RENDER,
        html: htmlRef.current,
      };
      // An opaque origin matches no target origin but "*"; the HTML is what the frame shows anyway.
      frameWindow.postMessage(message, "*");
    };
    window.addEventListener("message", answerReady);
    return () => window.removeEventListener("message", answerReady);
  }, []);

  useEffect(() => {
    htmlRef.current = html;
    if (ref.current !== null) ref.current.src = htmlFrameUrl(serverBase());
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
