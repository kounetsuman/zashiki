import { expect, test } from "@playwright/test";

// Feature: a Mermaid diagram in the Markdown preview is first drawn in a page that cannot fetch from
// outside the app. Why guard this in a real browser: jsdom fetches no images, so only a browser shows
// that drawing a diagram with a remote image node sends no request to that host.

const REMOTE = /https:\/\/img\.example\//;

interface ProbeWindow {
  probeMermaid(
    id: string,
    source: string,
  ): Promise<{ kind: string; hosts?: string[]; svg?: string }>;
}

test.describe("Mermaid probe page", () => {
  test("names the host of a remote image node without requesting it", async ({
    page,
  }) => {
    const requested: string[] = [];
    await page.route(REMOTE, (route) => {
      requested.push(route.request().url());
      return route.abort();
    });
    await page.goto("/mermaid-probe.html");
    const result = await page.evaluate(() =>
      (window as unknown as ProbeWindow).probeMermaid(
        "probe-remote",
        'flowchart TD\n  A@{ img: "https://img.example/a.png" }\n  B["<img src=\'https://img.example/b.png\'>"]',
      ),
    );
    expect(result).toEqual({ kind: "remote", hosts: ["img.example"] });
    expect(requested).toEqual([]);
  });

  test("returns the drawing of a diagram without remote references", async ({
    page,
  }) => {
    await page.goto("/mermaid-probe.html");
    const result = await page.evaluate(() =>
      (window as unknown as ProbeWindow).probeMermaid(
        "probe-local",
        "flowchart TD\n  A-->B",
      ),
    );
    expect(result.kind).toBe("rendered");
    expect(result.svg).toContain("<svg");
  });
});
