import type { Page } from "@playwright/test";

import { expect, gotoApp, test } from "../harness/app.js";

// Feature: the opt-in Memo tab. Enabling it in Settings pins a non-closeable Memo tab to the front of
// the Cockpit Tabs; disabling it removes the tab. The editor's typing / Cmd-S save / dirty-dot
// behavior is guarded by unit tests (memo-model, tab-model) and the manual checklist, so here we only
// thinly check the settings -> tab critical path.

function memoTab(page: Page) {
  return page
    .getByRole("tablist", { name: "Open tabs" })
    .getByRole("tab", { name: "Memo" });
}

async function setMemoEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Show the Memo tab").setChecked(enabled);
  await page.keyboard.press("Escape");
}

test.describe("Memo tab", () => {
  test("enabling the setting pins a non-closeable Memo tab at the front", async ({
    page,
  }) => {
    await gotoApp(page);
    await expect(memoTab(page)).toHaveCount(0);

    await setMemoEnabled(page, true);

    await expect(memoTab(page)).toBeVisible();
    // Pinned at the front of the tab strip.
    await expect(
      page.getByRole("tablist", { name: "Open tabs" }).getByRole("tab").first(),
    ).toHaveAccessibleName("Memo");
    // Non-closeable: the Memo tab has no close button (unlike session/viewer tabs).
    await expect(
      page.getByRole("button", { name: "Close the Memo tab" }),
    ).toHaveCount(0);
  });

  test("disabling the setting removes the Memo tab", async ({ page }) => {
    await gotoApp(page);
    await setMemoEnabled(page, true);
    await expect(memoTab(page)).toBeVisible();

    await setMemoEnabled(page, false);
    await expect(memoTab(page)).toHaveCount(0);
  });
});
