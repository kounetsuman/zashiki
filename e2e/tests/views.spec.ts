import type { Page } from "@playwright/test";

import { expect, gotoApp, test } from "../harness/app.js";

// Feature: footer view switching (explorer / search / source control / notification / help)
// Why guard this: single-select mutual exclusion and toggle-close are the paths users
// touch most. The correctness of each view's contents is guarded by unit tests, so here
// we only thinly check the "can switch / can close" path.

// The default selection (explorer) is covered by the "initial display" test, so the
// switching loop only iterates over the non-default views.
const SWITCHABLE_VIEWS = [
  { label: "Search", view: "search" },
  { label: "Source Control", view: "sourceControl" },
  { label: "Notifications", view: "notification" },
  { label: "Help", view: "help" },
] as const;

function viewTab(page: Page, label: string) {
  return page
    .getByRole("radiogroup", { name: "Switch view" })
    .getByRole("radio", { name: label });
}

test.describe("Footer view switching", () => {
  // Story: by default the explorer is open
  test("on initial display the explorer view is selected", async ({ page }) => {
    await gotoApp(page);
    await expect(viewTab(page, "Explorer")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator('[data-view="explorer"]')).toBeVisible();
  });

  // Story: each view can be switched to
  for (const { label, view } of SWITCHABLE_VIEWS) {
    test(`switching to "${label}" displays the ${view} view`, async ({
      page,
    }) => {
      await gotoApp(page);
      await viewTab(page, label).click();
      await expect(viewTab(page, label)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(page.locator(`[data-view="${view}"]`)).toBeVisible();
    });
  }

  // Story: re-clicking the icon of the currently selected view closes it (toggle close)
  test("re-clicking the currently shown view closes it", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('[data-view="explorer"]')).toBeVisible();
    await viewTab(page, "Explorer").click();
    await expect(viewTab(page, "Explorer")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(page.locator('[data-view="explorer"]')).toHaveCount(0);
  });
});
