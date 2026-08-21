import { expect, type Page, test } from "@playwright/test";

import { E2E_TOKEN } from "./constants.js";

/** Entry URL carrying the token. The client strips the token from the URL after accepting it. */
export function appUrl(token: string = E2E_TOKEN): string {
  return `/?token=${encodeURIComponent(token)}`;
}

/**
 * Open the app and wait until the control WS is open and the first state.sync has been applied.
 */
export async function gotoApp(page: Page): Promise<void> {
  // Keep in sync with client FIRST_RUN_WIZARD_SEEN_KEY; dismisses the first-run wizard backdrop.
  await page.addInitScript(() => {
    localStorage.setItem("zk.firstRunWizard.seen", "1");
  });
  await page.goto(appUrl());
  await expect(page.getByText("No sessions")).toBeVisible();
}

export { expect, test };
