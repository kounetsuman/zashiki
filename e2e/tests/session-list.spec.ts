import { expect, gotoApp, test } from "../harness/app.js";
import { E2E_ORGS } from "../harness/constants.js";

// Feature: the session list (SESSION LIST)
// Why guard this: orgs derived from repos.conf are listed as headings, and creating a new
// session from them is the cockpit's entry point. The guidance branch for zero orgs lives
// in the unit tests, so here we only thinly check the happy path of "fixture orgs are
// listed / can be collapsed and expanded".

// Each test runs against the harness's fixture orgs (default acme / globex).
test.describe("Session list (SESSION LIST)", () => {
  // Story: orgs derived from the repos root are listed as zero-count headings
  for (const org of E2E_ORGS) {
    test(`org "${org}" is displayed as a heading with a count of (0)`, async ({
      page,
    }) => {
      await gotoApp(page);
      await expect(
        page.getByRole("button", { name: new RegExp(`${org} \\(0\\)`) }),
      ).toBeVisible();
    });

    test(`org "${org}" has a + button for creating a new session`, async ({
      page,
    }) => {
      await gotoApp(page);
      await expect(
        page.getByRole("button", { name: `${org} に新規セッション` }),
      ).toBeVisible();
    });
  }

  // Story: org headings can be collapsed / expanded (aria-expanded toggles)
  test("clicking an org heading collapses it and re-clicking expands it", async ({
    page,
  }) => {
    await gotoApp(page);
    const org = E2E_ORGS[0] ?? "acme";
    const header = page.getByRole("button", {
      name: new RegExp(`${org} \\(0\\)`),
    });
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
  });
});
