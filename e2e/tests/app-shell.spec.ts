import { expect, gotoApp, test } from "../harness/app.js";

// Feature: App shell startup and the token gate
// Why guard this: the minimal conditions for browser e2e to work at all (the token
// boundary and initial render). When this is green, the preconditions for the later
// panel and list tests are in place.
test.describe("App shell startup and the token gate", () => {
  // Story: an entry point with no token shows the guidance screen
  test("a URL with no token shows the guidance screen (reopen from ?token=)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("No token found")).toBeVisible();
    await expect(page.getByRole("heading", { name: "zashiki" })).toBeVisible();
  });

  // Story: a valid token boots the app itself
  test("a valid token renders the SESSION LIST, panel switcher, and conversation area", async ({
    page,
  }) => {
    await gotoApp(page);
    await expect(page.getByText("SESSION LIST")).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Switch panel" }),
    ).toBeVisible();
    await expect(page.locator('[data-panel="conversation"]')).toBeVisible();
  });

  // Story: the empty state of the conversation area when there are no sessions
  test("when there are no sessions, the conversation area shows the no-sessions message", async ({
    page,
  }) => {
    await gotoApp(page);
    await expect(page.getByText("No sessions")).toBeVisible();
  });

  // Story: the accepted token is not left in the URL (history / bookmarks) (source of truth: packages/client/src/lib/token.test.ts)
  test("after the token is accepted, it is removed from the URL", async ({
    page,
  }) => {
    await gotoApp(page);
    expect(page.url()).not.toContain("token=");
  });
});
