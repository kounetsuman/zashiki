// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { probeMermaid, renderRemoteMermaid } from "./mermaid-probe.js";

async function startedFrame(page: string): Promise<HTMLIFrameElement> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frame = document.querySelector<HTMLIFrameElement>(
    `iframe[src="${page}"]`,
  );
  if (frame === null) throw new Error(`no frame on ${page}`);
  Object.assign(frame.contentWindow as object, {
    probeMermaid: async () => ({ kind: "rendered", svg: page }),
  });
  frame.dispatchEvent(new Event("load"));
  return frame;
}

describe("the Mermaid drawing pages", () => {
  it("probes in the page that loads nothing and draws an approved remote diagram in the page that may load its images", async () => {
    const probed = probeMermaid("a", "graph TD;");
    await startedFrame("/mermaid-probe.html");
    await expect(probed).resolves.toEqual({
      kind: "rendered",
      svg: "/mermaid-probe.html",
    });
    const drawn = renderRemoteMermaid("b", "graph TD;");
    await startedFrame("/mermaid-render.html");
    await expect(drawn).resolves.toEqual({
      kind: "rendered",
      svg: "/mermaid-render.html",
    });
  });
});
