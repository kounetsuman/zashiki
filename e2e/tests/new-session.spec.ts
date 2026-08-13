import { expect, gotoApp, test } from "../harness/app.js";
import { E2E_MUTABLE_ORG } from "../harness/constants.js";

// Feature: create a new session from the SESSION LIST
// Why guard this: "creating a new session from an org heading" is the cockpit's entry
// point. If this breaks, nothing can be started. The existing session-list.spec only
// checks that the + button is "displayed", so the actual path where clicking creates a
// session (both the + button and the right-click "new session" routes) was uncovered.
// Even with the owned backend + ZK_NO_CLAUDE, creation works as a plain-shell spawn.

// Because the server is shared and tests run in parallel, this file (whose counts change
// on creation) is confined to a dedicated org (E2E_MUTABLE_ORG) so it does not conflict
// with the (0) precondition in other files. Both tests touch the same org, so this file
// runs serially.
test.describe.configure({ mode: "serial" });

const org = E2E_MUTABLE_ORG;

/** Close all currently open session rows for the given org, returning the heading to (0). */
async function closeAllRows(
  page: import("@playwright/test").Page,
): Promise<void> {
  const closeButtons = page.getByRole("button", { name: `${org} を閉じる` });
  for (
    let n = await closeButtons.count();
    n > 0;
    n = await closeButtons.count()
  ) {
    await closeButtons.first().click();
    await expect(closeButtons).toHaveCount(n - 1);
  }
}

test.describe("Creating a new session from the SESSION LIST", () => {
  // Reset the org to empty every time (including on failure) so retries and later tests start from (0).
  test.afterEach(async ({ page }) => {
    await closeAllRows(page);
  });

  test("the + button creates a new session and a row appears", async ({
    page,
  }) => {
    await gotoApp(page);
    await expect(
      page.getByRole("button", { name: new RegExp(`${org} \\(0\\)`) }),
    ).toBeVisible();

    await page.getByRole("button", { name: `${org} に新規セッション` }).click();

    // The heading count becomes (1) and one session row for the org appears.
    await expect(
      page.getByRole("button", { name: new RegExp(`${org} \\(1\\)`) }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `${org} を閉じる` }),
    ).toHaveCount(1);
  });

  test('the right-click "new session" menu creates a new session', async ({
    page,
  }) => {
    await gotoApp(page);
    const header = page.getByRole("button", {
      name: new RegExp(`${org} \\(0\\)`),
    });
    await expect(header).toBeVisible();

    await header.click({ button: "right" });
    await page.getByRole("menuitem", { name: "新規セッション" }).click();

    await expect(
      page.getByRole("button", { name: new RegExp(`${org} \\(1\\)`) }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `${org} を閉じる` }),
    ).toHaveCount(1);
  });

  // Story: opening a new session actually attaches the terminal, and typed input echoes back.
  // Under owned, if term.open/select does not branch for tmux, the terminal stays empty and
  // an internal error appears (tmux select-window $N:UUID can't find window). This thinly
  // guards the path "create -> auto-select -> attach -> echo". Because of ZK_NO_CLAUDE a
  // plain shell starts, so echo is reflected back verbatim.
  test("opening a new session attaches the terminal and typed input echoes back (not empty, no error)", async ({
    page,
  }) => {
    await gotoApp(page);
    await expect(
      page.getByRole("button", { name: new RegExp(`${org} \\(0\\)`) }),
    ).toBeVisible();

    await page.getByRole("button", { name: `${org} に新規セッション` }).click();
    await expect(
      page.getByRole("button", { name: new RegExp(`${org} \\(1\\)`) }),
    ).toBeVisible();

    // Type into the terminal that was auto-selected right after creation. If the marker
    // appears on screen as an echo, that proves a bidirectional connection to the PTY
    // (i.e. not empty, not unknown_term).
    const marker = `zashiki-attached-${Date.now()}`;
    const terminal = page.locator(".terminal-view");
    await expect(terminal).toBeVisible();
    await terminal.click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");

    await expect(terminal).toContainText(marker, { timeout: 10_000 });

    // Under owned, if term.select hits tmux, an internal error shows in a dialog. Assert it does not.
    await expect(page.getByRole("alertdialog", { name: "エラー" })).toHaveCount(
      0,
    );
  });
});
