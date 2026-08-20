//! Dev-only launcher for an isolated zashiki instance (`pnpm -F @zashiki/desktop dev:sandbox`).
//!
//! It materializes a throwaway temp sandbox (color-coded org dirs + git-initialized repos + repos.conf)
//! and runs `tauri dev` with the sandbox ZK_* env, so the Tauri sidecar spawns the server pointed
//! entirely at that sandbox (isolated saves/projects/config/token). It seeds no sessions — the SESSION
//! LIST starts empty and new sessions launch real Claude — so you can develop against a clean instance
//! alongside a production app on 8790 without touching real user data (~/.zashiki / ~/.claude). The temp
//! dir is removed on exit.
//!
//! Customize the orgs/repos by copying the printed spec to a file and passing `--config <path>` (or the
//! ZASHIKI_SANDBOX_CONFIG env). The spec shape is { orgs:[{name,color?}], repos:[{org,repo}] }.

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
/** 8791, not 8790, so the sandbox runs alongside a production app already on 8790. Flows to the
 *  sidecar (ZK_PORT) and to the Vite client via tauri.conf.json's `VITE_ZK_SERVER=…:${ZK_PORT:-8790}`. */
const DEV_PORT = 8791;

/** The built-in scene: three color-coded orgs, each with a couple of repos to create sessions in. */
function defaultSpec() {
  return {
    orgs: [
      { name: "web-app", color: "#7aa2f7" },
      { name: "api", color: "#98c379" },
      { name: "infra", color: "#e0af68" },
    ],
    repos: [
      { org: "web-app", repo: "storefront" },
      { org: "web-app", repo: "checkout" },
      { org: "api", repo: "gateway" },
      { org: "api", repo: "billing" },
      { org: "infra", repo: "pipeline" },
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

/** Validates a sandbox spec. Returns an error string, or null if OK. */
function validateSpec(spec) {
  if (spec == null || typeof spec !== "object")
    return "sandbox config must be a JSON object";
  if (!Array.isArray(spec.orgs) || spec.orgs.length === 0)
    return "sandbox config: `orgs` must be a non-empty array";
  const orgNames = new Set();
  for (const org of spec.orgs) {
    if (org == null || !isSafeSegment(org.name))
      return "sandbox config: each org needs a `name` that is a plain segment (not '.', '..', whitespace, or a path)";
    if (orgNames.has(org.name))
      return `sandbox config: duplicate org name: ${org.name}`;
    orgNames.add(org.name);
    if (org.color != null && !isColorToken(org.color))
      return `sandbox config: invalid color for org ${org.name}: ${org.color}`;
  }
  if (!Array.isArray(spec.repos) || spec.repos.length === 0)
    return "sandbox config: `repos` must be a non-empty array";
  for (const repo of spec.repos) {
    if (repo == null || typeof repo !== "object")
      return "sandbox config: each repo must be an object";
    if (!orgNames.has(repo.org))
      return `sandbox config: repo references unknown org: ${repo.org}`;
    if (!isSafeSegment(repo.repo))
      return `sandbox config: repo needs a plain repo segment (not '.', '..', whitespace, or a path) (org ${repo.org})`;
  }
  return null;
}

/** The repos.conf body: one `<root>/<org>  #color` line per org (color when present). */
function reposConf(spec, root) {
  return `${spec.orgs
    .map((org) => {
      const path = join(root, org.name);
      return org.color ? `${path}  ${org.color}` : path;
    })
    .join("\n")}\n`;
}

/** The unique directories to create (org dirs and per-repo dirs). */
function sandboxDirs(spec, root) {
  const dirs = new Set();
  for (const org of spec.orgs) dirs.add(join(root, org.name));
  for (const repo of spec.repos) dirs.add(join(root, repo.org, repo.repo));
  return [...dirs];
}

/** The unique repo (org/repo leaf) dirs, which must be git repos for `/api/fs/repos` to list them. */
function repoDirs(spec, root) {
  return [...new Set(spec.repos.map((r) => join(root, r.org, r.repo)))];
}

function parseArgs(argv) {
  let config = process.env.ZASHIKI_SANDBOX_CONFIG ?? null;
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
  if (configPath == null) return defaultSpec();
  let spec;
  try {
    spec = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    process.stderr.write(
      `Failed to read/parse sandbox config (${configPath}): ${e.message}\n`,
    );
    process.exit(1);
  }
  const error = validateSpec(spec);
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exit(1);
  }
  return spec;
}

/** Whether a zashiki server is already healthy on `port` (a busy dev port makes the sidecar ride along). */
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
      `zashiki sandbox: a server is already running on ${DEV_PORT}; the app would ride along on it.\n` +
        "Fix: stop it first (e.g. quit another sandbox, or `pkill -f zashiki-server`), then rerun.\n",
    );
    process.exit(1);
  }

  const root = mkdtempSync(join(tmpdir(), "zashiki-sandbox-"));
  for (const dir of sandboxDirs(spec, root))
    mkdirSync(dir, { recursive: true });
  for (const repo of repoDirs(spec, root))
    execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "saves"), { recursive: true });

  const specPath = join(root, "sandbox-spec.json");
  writeFileSync(join(root, "repos.conf"), reposConf(spec, root));
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
  };

  process.stdout.write(
    `zashiki sandbox: ${root} (removed on exit; real ~/.zashiki / ~/.claude untouched)\n` +
      `zashiki sandbox: empty SESSION LIST, real claude on new sessions\n` +
      `zashiki sandbox: edit ${specPath} then rerun with --config <path> to change orgs/repos\n` +
      "zashiki sandbox: launching `tauri dev` …\n",
  );

  // Run the same dev pipeline as `pnpm dev` (tauri dev), but with the sandbox env inherited by the
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
