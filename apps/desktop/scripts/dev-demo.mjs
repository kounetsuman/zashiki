//! Dev-only launcher for the demo sandbox in the desktop app (`pnpm -F @zashiki/desktop dev:demo`,
//! or `ZASHIKI_DEMO=1 pnpm -F @zashiki/desktop dev` — this script is what that maps to).
//!
//! The demo is a development / screen-recording affordance, NOT a shipped feature, so it lives here in
//! the desktop dev workflow rather than in the published `zashiki` CLI. It materializes an isolated temp
//! sandbox (color-coded org dirs + repos.conf + a seed JSON) and runs `tauri dev` with the demo ZK_*
//! env, so the Tauri sidecar spawns the server pointed entirely at that sandbox (ZK_NO_CLAUDE, isolated
//! saves/projects/config/token) and seeds it via ZK_DEMO_SEED (see crates/zashiki-server/src/demo_seed.rs).
//! Real user data (~/.zashiki / ~/.claude) is never touched; the temp dir is removed on exit.
//!
//! Customize the scene by copying the printed spec to a file and passing `--config <path>` (or the
//! ZASHIKI_DEMO_CONFIG env). The spec shape is { orgs:[{name,color?}], sessions:[{org,repo,title?,state}] }.

import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 8791, not 8790, so the demo sandbox runs alongside a production app already on 8790. Flows to the
 *  sidecar (ZK_PORT) and to the Vite client via tauri.conf.json's `VITE_ZK_SERVER=…:${ZK_PORT:-8790}`. */
const DEV_PORT = 8791;
const DEMO_STATES = [
  "running",
  "waiting_input",
  "idle",
  "running_bg_agent",
  "no_claude",
];

/** The built-in demo scene: three color-coded orgs with a mix of session states and titles. */
function defaultDemoSpec() {
  return {
    orgs: [
      { name: "web-app", color: "#7aa2f7" },
      { name: "api", color: "#98c379" },
      { name: "infra", color: "#e0af68" },
    ],
    sessions: [
      {
        org: "web-app",
        repo: "storefront",
        title: "Refactor the checkout flow",
        state: "running",
      },
      {
        org: "web-app",
        repo: "checkout",
        title: "Approve the payment migration",
        state: "waiting_input",
      },
      {
        org: "api",
        repo: "gateway",
        title: "Investigate the flaky auth test",
        state: "idle",
      },
      {
        org: "api",
        repo: "billing",
        title: "Tidy invoice rounding edge cases",
        state: "no_claude",
      },
      {
        org: "infra",
        repo: "pipeline",
        title: "Plan the VPC network changes",
        state: "running",
      },
    ],
  };
}

/** A path segment safe under the temp sandbox: non-empty, no whitespace or `/`, and not `.` / `..`. */
function isSafeSegment(name) {
  return (
    typeof name === "string" &&
    /^[^\s/]+$/.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

function isColorToken(token) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(token);
}

/** Validates a demo spec. Returns an error string, or null if OK. */
function validateDemoSpec(spec) {
  if (spec == null || typeof spec !== "object")
    return "demo config must be a JSON object";
  if (!Array.isArray(spec.orgs) || spec.orgs.length === 0)
    return "demo config: `orgs` must be a non-empty array";
  const orgNames = new Set();
  for (const org of spec.orgs) {
    if (org == null || !isSafeSegment(org.name))
      return "demo config: each org needs a `name` that is a plain segment (not '.', '..', whitespace, or a path)";
    if (orgNames.has(org.name))
      return `demo config: duplicate org name: ${org.name}`;
    orgNames.add(org.name);
    if (org.color != null && !isColorToken(org.color))
      return `demo config: invalid color for org ${org.name}: ${org.color}`;
  }
  if (!Array.isArray(spec.sessions) || spec.sessions.length === 0)
    return "demo config: `sessions` must be a non-empty array";
  for (const session of spec.sessions) {
    if (session == null || typeof session !== "object")
      return "demo config: each session must be an object";
    if (!orgNames.has(session.org))
      return `demo config: session references unknown org: ${session.org}`;
    if (!isSafeSegment(session.repo))
      return `demo config: session needs a plain repo segment (not '.', '..', whitespace, or a path) (org ${session.org})`;
    if (!DEMO_STATES.includes(session.state))
      return `demo config: session has unknown state: ${session.state}`;
  }
  return null;
}

/** The repos.conf body: one `<root>/<org>  #color` line per org (color when present). */
function demoReposConf(spec, root) {
  return `${spec.orgs
    .map((org) => {
      const path = join(root, org.name);
      return org.color ? `${path}  ${org.color}` : path;
    })
    .join("\n")}\n`;
}

/** The server seed JSON (ZK_DEMO_SEED): each session's absolute cwd, title, and state. */
function demoSeed(spec, root) {
  return {
    sessions: spec.sessions.map((session) => ({
      cwd: join(root, session.org, session.repo),
      title: session.title ?? "",
      state: session.state,
    })),
  };
}

/** The unique directories to create (org dirs and per-session repo dirs). */
function demoDirs(spec, root) {
  const dirs = new Set();
  for (const org of spec.orgs) dirs.add(join(root, org.name));
  for (const session of spec.sessions)
    dirs.add(join(root, session.org, session.repo));
  return [...dirs];
}

/** The unique repo (org/repo leaf) dirs, which must be git repos for `/api/fs/repos` to list them. */
function demoRepoDirs(spec, root) {
  return [...new Set(spec.sessions.map((s) => join(root, s.org, s.repo)))];
}

function parseArgs(argv) {
  let config = process.env.ZASHIKI_DEMO_CONFIG ?? null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      config = argv[++i] ?? null;
    } else if (argv[i].startsWith("--config=")) {
      config = argv[i].slice("--config=".length);
    }
  }
  return { config };
}

function loadSpec(configPath) {
  if (configPath == null) return defaultDemoSpec();
  let spec;
  try {
    spec = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    process.stderr.write(
      `Failed to read/parse demo config (${configPath}): ${e.message}\n`,
    );
    process.exit(1);
  }
  const error = validateDemoSpec(spec);
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exit(1);
  }
  return spec;
}

/** Whether a zashiki server is already healthy on `port` (a busy dev port makes the sidecar ride along = no demo seed). */
async function portOccupiedByServer(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    return res.status === 200 && (await res.text()).includes('"status":"ok"');
  } catch {
    return false;
  }
}

async function main() {
  const { config } = parseArgs(process.argv.slice(2));
  const spec = loadSpec(config);

  if (await portOccupiedByServer(DEV_PORT)) {
    process.stderr.write(
      `zashiki demo: a server is already running on ${DEV_PORT}; in dev the app would ride along on it and skip demo seeding.\n` +
        "Fix: stop it first (e.g. quit the installed Zashiki app / daemon, or `pkill -f zashiki-server`), then rerun.\n",
    );
    process.exit(1);
  }

  const root = mkdtempSync(join(tmpdir(), "zashiki-demo-"));
  for (const dir of demoDirs(spec, root)) mkdirSync(dir, { recursive: true });
  for (const repo of demoRepoDirs(spec, root))
    execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "saves"), { recursive: true });

  const seedPath = join(root, "seed.json");
  const specPath = join(root, "demo-spec.json");
  writeFileSync(join(root, "repos.conf"), demoReposConf(spec, root));
  writeFileSync(seedPath, `${JSON.stringify(demoSeed(spec, root), null, 2)}\n`);
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(join(root, "config.json"), "{}\n");

  const env = {
    ...process.env,
    ZK_PORT: String(DEV_PORT),
    ZK_TOKEN_FILE: join(root, "token"),
    ZK_REPOS_CONF: join(root, "repos.conf"),
    ZK_SAVES_DIR: join(root, "saves"),
    ZK_PROJECTS_ROOT: join(root, "projects"),
    ZK_CONFIG: join(root, "config.json"),
    ZK_NO_CLAUDE: "1",
    ZK_DEMO_SEED: seedPath,
  };

  process.stdout.write(
    `zashiki demo sandbox: ${root} (removed on exit; real ~/.zashiki / ~/.claude untouched)\n` +
      `zashiki demo: edit ${specPath} then rerun with --config <path> to change session states/titles\n` +
      "zashiki demo: launching `tauri dev` …\n",
  );

  // Run the same dev pipeline as `pnpm dev` (tauri dev), but with the demo env inherited by the
  // sidecar and, in turn, the server it spawns.
  const child = spawn("pnpm", ["exec", "tauri", "dev"], {
    cwd: DESKTOP_DIR,
    stdio: "inherit",
    env,
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // The OS reclaims the temp dir eventually; a cleanup failure must not mask the real exit.
    }
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    });
  }
  child.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
  child.on("error", (e) => {
    process.stderr.write(`Failed to launch tauri dev: ${e.message}\n`);
    cleanup();
    process.exit(1);
  });
}

main();
