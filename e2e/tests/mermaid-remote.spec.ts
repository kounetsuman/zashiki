import { expect, gotoApp, test } from "../harness/app.js";

// Feature: opening a Markdown file never fetches what its Mermaid diagrams refer to outside the repo.
// Why guard this in a real browser: jsdom fetches nothing, so only a browser shows that no request
// reaches the remote host, including when the pointer rests on a drawn diagram.

const REMOTE = /^https:\/\/img\.example\//;

test.describe("Mermaid diagrams in the Markdown preview", () => {
  test("make no remote request on open or under the pointer, and load one only after its button is clicked", async ({
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
    const box = await page.locator(".viewer-mermaid-frame").boundingBox();
    if (box === null) throw new Error("the diagram frame is not shown");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);

    await button.click();
    await expect
      .poll(() => requested)
      .toContain("https://img.example/node.png");
  });
});
