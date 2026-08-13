// Server harness launched by Playwright's webServer (post-cutover: the Rust zashiki-server).
//
// Starts the same Rust binary as production with the owned backend (default). To make the browser e2e
// deterministic, it injects a fixed token, fixture orgs, and isolated directories (saves / projects /
// config) via env so it never touches the real ~/.claude/projects / real ~/.zashiki / real sessions.
//
// - token: ZK_TOKEN fixed (carried in the URL when opening; overrides production's random generation)
// - sessions: for owned, SessionRegistry is the only session source. Right after startup there are 0.
// - repos.conf: fixture orgs only (the SESSION LIST headings; never reads the real conf)
// - saves / projects / config: isolated (never reads or writes real user data)
// - client dist: serves packages/client/dist via ZK_CLIENT_DIST
//
// It is plain JS (.mjs) because webServer runs it in a separate, bare node process.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(harnessDir, "..", "..");

const E2E_TOKEN = process.env.ZK_E2E_TOKEN ?? "e2e-fixed-token";
const E2E_PORT = process.env.ZK_E2E_PORT ?? "8799";

// Fixture orgs. The basename becomes the org heading in the SESSION LIST.
const fixtureRoot = join(tmpdir(), "zashiki-e2e-repos");
const orgs = (process.env.ZK_E2E_ORGS ?? "acme,globex")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
// An org dedicated to mutation (new session creation) tests. Listed in repos.conf separately from the
// ZK_E2E_ORGS that read-only tests iterate, so an increased count from creation does not conflict with
// other tests' (0) assumption.
const mutableOrg = process.env.ZK_E2E_MUTABLE_ORG ?? "initech";
const reposRoots = [...orgs, mutableOrg].map((org) => join(fixtureRoot, org));
for (const dir of reposRoots) mkdirSync(dir, { recursive: true });

const reposConfPath = join(fixtureRoot, "repos.conf");
writeFileSync(reposConfPath, `${reposRoots.join("\n")}\n`);

const savesDir = join(fixtureRoot, "saves");
const projectsRoot = join(fixtureRoot, "projects");
const configPath = join(fixtureRoot, "config.json");
// Isolate the token too (so as not to overwrite the default ~/.zashiki/token).
const tokenFile = join(fixtureRoot, "token");
// Carrying over the previous saves would revive owned sessions on restore, destabilizing the (0)
// assumption and the creation tests. Empty saves on each startup (CI is clean to begin with, but this
// clears leftovers from local reruns).
rmSync(savesDir, { recursive: true, force: true });
for (const dir of [savesDir, projectsRoot]) mkdirSync(dir, { recursive: true });

// Resolve the Rust server binary (ZK_SERVER_BIN > release > debug).
function resolveServerBin() {
  if (process.env.ZK_SERVER_BIN) return process.env.ZK_SERVER_BIN;
  const target = join(repoRoot, "crates", "zashiki-server", "target");
  const release = join(target, "release", "zashiki-server");
  const debug = join(target, "debug", "zashiki-server");
  if (existsSync(release)) return release;
  if (existsSync(debug)) return debug;
  throw new Error(
    "zashiki-server binary not found. Run `cargo build --manifest-path crates/zashiki-server/Cargo.toml` or set ZK_SERVER_BIN.",
  );
}

const serverBin = resolveServerBin();
const clientDist = join(repoRoot, "packages", "client", "dist");

const child = spawn(serverBin, [], {
  stdio: "inherit",
  env: {
    ...process.env,
    ZK_PORT: String(E2E_PORT),
    ZK_TOKEN: E2E_TOKEN,
    ZK_TOKEN_FILE: tokenFile,
    ZK_REPOS_CONF: reposConfPath,
    ZK_SAVES_DIR: savesDir,
    ZK_PROJECTS_ROOT: projectsRoot,
    ZK_CONFIG: configPath,
    ZK_CLIENT_DIST: clientDist,
    ZK_NO_CLAUDE: "1",
    ZK_POLL: "3600",
  },
});

console.log(
  `[e2e-harness] spawned ${serverBin} on http://127.0.0.1:${E2E_PORT}`,
);

child.on("exit", (code) => process.exit(code ?? 0));
const shutdown = () => child.kill("SIGTERM");
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
