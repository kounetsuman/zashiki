import mermaid from "mermaid";
import { MERMAID_CONFIG } from "./mermaid-config.js";
import type {
  MermaidProbeResult,
  MermaidProbeWindow,
} from "./mermaid-probe.js";
import { remoteImageHost } from "./remote-host.js";
import { remoteHostsIn } from "./remote-references.js";

mermaid.initialize(MERMAID_CONFIG);

const requested = new Set<string>();
const noteRequest = (url: string) => {
  const host = remoteImageHost(url);
  if (host !== null) requested.add(host);
};

document.addEventListener(
  "securitypolicyviolation",
  (event) => noteRequest(event.blockedURI),
  true,
);

const imageSrc = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "src",
);
if (imageSrc?.set !== undefined) {
  const setSrc = imageSrc.set;
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    ...imageSrc,
    set(this: HTMLImageElement, value: string) {
      noteRequest(String(value));
      setSrc.call(this, value);
    },
  });
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function probeMermaid(
  id: string,
  source: string,
): Promise<MermaidProbeResult> {
  requested.clear();
  let svg: string | null = null;
  try {
    ({ svg } = await mermaid.render(id, source));
  } catch {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
  const hosts = new Set<string>();
  if (svg !== null) {
    const holder = document.createElement("div");
    holder.innerHTML = svg;
    document.body.appendChild(holder);
    for (const host of remoteHostsIn(holder)) hosts.add(host);
    holder.remove();
  }
  await nextTask();
  for (const host of requested) hosts.add(host);
  if (hosts.size > 0) return { kind: "remote", hosts: [...hosts].sort() };
  return svg === null ? { kind: "failed" } : { kind: "rendered", svg };
}

(window as unknown as MermaidProbeWindow).probeMermaid = probeMermaid;
