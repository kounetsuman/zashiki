// Constants shared by the e2e harness and tests (no side effects).
// playwright.config.ts also propagates them to boot.mjs via webServer.env.

export const E2E_PORT = Number(process.env.ZK_E2E_PORT ?? "8799");
export const E2E_TOKEN = process.env.ZK_E2E_TOKEN ?? "e2e-fixed-token";
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** Fixture orgs. Listed as headings (basename) in the SESSION LIST. */
export const E2E_ORGS = (process.env.ZK_E2E_ORGS ?? "acme,globex")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/**
 * An org dedicated to mutation (new session creation) tests. Listed in repos.conf separately from
 * E2E_ORGS, and not included in the E2E_ORGS that read-only tests (e.g. asserting a (0) count) iterate.
 * This keeps "creation increases the count" tests from conflicting with other tests' (0) assumption even
 * under a shared server and parallel execution.
 */
export const E2E_MUTABLE_ORG = process.env.ZK_E2E_MUTABLE_ORG ?? "initech";
