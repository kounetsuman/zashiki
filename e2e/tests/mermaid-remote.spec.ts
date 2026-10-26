import { expect, gotoApp, test } from "../harness/app.js";

// Feature: opening a Markdown file never fetches what its Mermaid diagrams refer to outside the repo.
// Why guard this in a real browser: jsdom fetches nothing, so only a browser shows that no request
// reaches the remote host, including when a drawn diagram is hovered.

const REMOTE = /^https:\/\/img\.example\//;

test.describe("Mermaid diagrams in the Markdown preview", () => {
  test("make no remote request on open or on hover, and load one only after its button is clicked", async ({
    page,
  }) => {
    const requested: string[] = [];
    await page.context().route(REMOTE, (route) => {
      requested.push(route.request().url());
      return route.abort();
    });

    await gotoApp(page);
    const explorer = page.locator('[data-view="explorer"]');
    await explorer.getByText("mermaid-docs").click();
    await explorer.getByText("README.md").click();
    await page.getByRole("button", { name: "Preview" }).click();

    const button = page.getByRole("button", { name: /img\.example/ });
    await expect(button).toBeVisible();
    await page
      .frameLocator(".viewer-mermaid-frame")
      .getByText("Hover me")
      .hover();
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);

    await button.click();
    await expect
      .poll(() => requested)
      .toContain("https://img.example/node.png");
  });
});
