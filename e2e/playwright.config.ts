import { defineConfig, devices } from "@playwright/test";

import {
  BASE_URL,
  E2E_MUTABLE_ORG,
  E2E_ORGS,
  E2E_PORT,
  E2E_TOKEN,
} from "./harness/constants.js";

// Verify the UI in browser mode (the Tauri shell itself is smoke + manual). boot.mjs programmatically
// starts the sidecar-equivalent server with a fixed token. Within the happy-path scope it never touches
// real sessions / real Claude.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  // Because all workers connect concurrently to a single programmatically-started server, give the
  // control WS connection wait extra headroom for the parallel load (the default 5s occasionally drops
  // connections under high parallelism).
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // The UI locale is auto-detected from the browser language (ja* -> ja, otherwise en).
    // Pin it so the asserted strings match regardless of the host environment.
    locale: "en-US",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node harness/boot.mjs",
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ZK_E2E_PORT: String(E2E_PORT),
      ZK_E2E_TOKEN: E2E_TOKEN,
      ZK_E2E_ORGS: E2E_ORGS.join(","),
      ZK_E2E_MUTABLE_ORG: E2E_MUTABLE_ORG,
    },
  },
});
