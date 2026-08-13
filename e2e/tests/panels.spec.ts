import type { Page } from "@playwright/test";

import { expect, gotoApp, test } from "../harness/app.js";

// Feature: footer panel switching (explorer / search / git / notification / help)
// Why guard this: single-select mutual exclusion and toggle-close are the paths users
// touch most. The correctness of each panel's contents is guarded by unit tests, so here
// we only thinly check the "can switch / can close" path.

// The default selection (explorer) is covered by the "initial display" test, so the
// switching loop only iterates over the non-default panels.
const SWITCHABLE_PANELS = [
  { label: "Search", panel: "search" },
  { label: "Source Control", panel: "git" },
  { label: "Notifications", panel: "notification" },
  { label: "Help", panel: "help" },
] as const;

function panelTab(page: Page, label: string) {
  return page
    .getByRole("radiogroup", { name: "Switch panel" })
    .getByRole("radio", { name: label });
}

test.describe("Footer panel switching", () => {
  // Story: by default the explorer is open
  test("on initial display the explorer panel is selected", async ({
    page,
  }) => {
    await gotoApp(page);
    await expect(panelTab(page, "Explorer")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator('[data-panel="explorer"]')).toBeVisible();
  });

  // Story: each panel can be switched to
  for (const { label, panel } of SWITCHABLE_PANELS) {
    test(`switching to "${label}" displays the ${panel} panel`, async ({
      page,
    }) => {
      await gotoApp(page);
      await panelTab(page, label).click();
      await expect(panelTab(page, label)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(page.locator(`[data-panel="${panel}"]`)).toBeVisible();
    });
  }

  // Story: re-clicking the icon of the currently selected panel closes it (toggle close)
  test("re-clicking the currently shown panel closes it", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('[data-panel="explorer"]')).toBeVisible();
    await panelTab(page, "Explorer").click();
    await expect(panelTab(page, "Explorer")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(page.locator('[data-panel="explorer"]')).toHaveCount(0);
  });
});
