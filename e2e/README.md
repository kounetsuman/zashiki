**English** | [日本語](./README.ja.md)

# e2e

Browser-mode E2E tests (Playwright). The UI is verified in the browser
(the Tauri shell itself is smoke-tested + manual).

## Layout

- `harness/boot.mjs` — A server harness that programmatically boots `createZashikiServer` with a **fixed token**.
  Launched from Playwright's `webServer`. It never touches real ps / real `~/.claude/projects` / real sessions,
  and listens deterministically with fixture organizations.
- `harness/constants.ts` — Port, fixed token, and fixture organizations (shared between the harness and the tests).
- `harness/app.ts` — Entry helpers such as `gotoApp(page)` (opens with `?token=` and waits for the shell to render).
- `tests/*.spec.ts` — Specs per feature domain. 1 describe = 1 user story,
  1 test = 1 acceptance criterion (the case names themselves form a table of contents for the spec).

## Running

The client / server dist are required, so build before running on the first run and after changes.

```sh
pnpm build                 # at the repository root (generates client dist / server dist)
pnpm -F @zashiki/e2e exec playwright install chromium   # first time only (fetch the browser)
pnpm e2e                   # run e2e from the root (= playwright test)
```

`pnpm e2e` automatically starts and stops the `webServer` (`node harness/boot.mjs`).
Locally, `reuseExistingServer` reuses an existing server.

## Scope (current)

- Only the **happy path** is implemented (app shell boot, view switching, session-list headings).
- session-lifecycle / terminal-io requiring a real PTY + fake claude, plus error and boundary cases, are follow-up issues.
- IME composition and terminal scrollback/copy cannot be faithfully reproduced in Playwright, so they are out of scope.
