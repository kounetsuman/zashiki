//! Startup orchestration for the zashiki command (the side-effecting side).
//! Reproduces start() from apps/desktop/src-tauri/src/sidecar.rs in Node:
//!   1. Determine the effective port (CLI flag > ZK_PORT > 8790).
//!   2. If /healthz is already OK, adopt the existing server (no spawn, no shutdown on exit).
//!   3. Otherwise spawn, passing ZK_CLIENT_DIST=bundled dist and ZK_TOKEN (self-generated).
//!   4. Poll /healthz until it responds.
//!   5. Open http://127.0.0.1:PORT/?token=TOKEN in the browser (the URL is always also printed to stdout).
//!   6. Forward SIGINT/SIGTERM to the child's process group and exit after a graceful shutdown.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyReuse,
  healthzField,
  healthzPid,
  initialUrl,
  isHealthyResponse,
  isHtmlDocument,
  isTokenAccepted,
  parseArgs,
  readToken,
  resolvePort,
  resolveServerBin,
  tokenFilePath,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

/** Upper bound for the server to respond to /healthz after startup (sidecar.rs SPAWN_HEALTH_TIMEOUT). */
const SPAWN_HEALTH_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;

/**
 * Grace to wait after SIGTERM for a stale resident server to release the port (sidecar.rs
 * STALE_RELEASE_TIMEOUT). Longer than the server's own SHUTDOWN_BUDGET (10s) so the graceful
 * "save session -> withdraw" is not interrupted. If exceeded, we give up rather than SIGKILL, since a
 * still-held port most likely means a KeepAlive daemon is respawning the same stale binary.
 */
const STALE_RELEASE_TIMEOUT_MS = 12_000;

/** Single GET. Connection failure or timeout returns null (the caller reads this as "not started"). */
async function httpGet(port, path, headers = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers,
      signal: AbortSignal.timeout(3_000),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
}

async function checkHealth(port) {
  const res = await httpGet(port, "/healthz");
  return res != null && isHealthyResponse(res.status, res.body);
}

async function servesClientUi(port) {
  const res = await httpGet(port, "/");
  return res != null && res.status === 200 && isHtmlDocument(res.body);
}

async function verifyToken(port, token) {
  const res = await httpGet(port, "/api/zk-shell/token-probe", {
    "x-zashiki-token": token,
  });
  return res != null && isTokenAccepted(res.status, res.body);
}

/** Poll at `interval` intervals until cond() is true. Returns false once the timeout is exceeded. */
async function pollUntil(cond, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Open the URL in the OS default browser (macOS `open` / Linux `xdg-open`). The URL is already printed even if this fails. */
function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Swallow the error since the URL is already printed (not fatal even if `open` is absent, e.g. headless).
  }
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  return pkg.version;
}

function printHelp() {
  process.stdout.write(
    [
      "zashiki — a web cockpit for viewing your Claude Code sessions at a glance",
      "",
      "Usage:",
      "  zashiki [options]",
      "",
      "Options:",
      "  -p, --port <n>   listen port (default: 8790 / env var ZK_PORT)",
      "      --no-open     do not open the browser automatically (the URL is printed)",
      "  -h, --help        show this help",
      "  -v, --version     show the version",
      "",
    ].join("\n"),
  );
}

/** Adopt an existing server (do not spawn one ourselves, and do not shut it down on exit). */
async function adopt(port, open) {
  // Reject the case where another process not serving the client dist occupies 8790 (sidecar.rs serves_client_ui).
  if (!(await servesClientUi(port))) {
    process.stderr.write(
      `The server running on port ${port} is not serving the client UI.\n` +
        "Another process may be occupying the port, or it may be an outdated setup.\n" +
        "Fix: stop the running process, or specify a different port with --port.\n",
    );
    process.exit(1);
  }
  const tokenPath = tokenFilePath({ port, env: process.env, home: homedir() });
  let token;
  try {
    token = readToken(readFileSync(tokenPath, "utf8"));
  } catch (e) {
    process.stderr.write(
      `Failed to read the token (${tokenPath}): ${e.message}\n`,
    );
    process.exit(1);
  }
  if (!(await verifyToken(port, token))) {
    process.stderr.write(
      "The token was not accepted by the running server (the token file may be stale).\n",
    );
    process.exit(1);
  }
  const url = initialUrl(`http://127.0.0.1:${port}`, token);
  process.stdout.write(`zashiki: using the running server → ${url}\n`);
  if (open) {
    openBrowser(url);
  }
}

/** Spawn the zashiki-server from the platform package (or ZK_SERVER_BIN) ourselves. */
async function spawnServer(port, open) {
  const requireResolve = createRequire(import.meta.url).resolve;
  let serverBin;
  try {
    serverBin = resolveServerBin({
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      requireResolve,
    });
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }

  const clientDist = join(pkgRoot, "client-dist");
  if (!existsSync(join(clientDist, "index.html"))) {
    process.stderr.write(
      `Bundled client dist not found (${clientDist}). The package may be corrupted.\n`,
    );
    process.exit(1);
  }

  // npm/pnpm pack strips the execute bit from non-bin files (normalizing to 0644). Restore
  // it to executable before spawn (if this fails, e.g. for root-owned files, the later spawn
  // error routes to the remediation message).
  try {
    chmodSync(serverBin, 0o755);
  } catch {
    // No permission, or already executable. Detected via the spawn failure.
  }

  // Inject a self-generated 48-hex token via ZK_TOKEN (avoiding the write lag of the server's
  // default generation and token-sharing races, and pinning the token in the URL we open).
  // Isolate ZK_TOKEN_FILE per port so a custom-port startup does not pollute the default
  // port's ~/.zashiki/token (shared by the daemon/sidecar).
  const token = randomBytes(24).toString("hex");
  const tokenFile = tokenFilePath({ port, env: process.env, home: homedir() });
  const child = spawn(serverBin, [], {
    stdio: "inherit",
    // Put it in its own process group so that on exit killpg reliably takes down grandchildren (claude) too.
    detached: true,
    env: {
      ...process.env,
      ZK_PORT: String(port),
      ZK_TOKEN: token,
      ZK_TOKEN_FILE: tokenFile,
      ZK_CLIENT_DIST: clientDist,
    },
  });

  // Share the exit code so that on a startup failure the child's exit handler does not
  // preempt it with code 0.
  let launchFailed = false;
  // Handle shutdown only when we spawned it ourselves. Send SIGTERM to the process group (-pid).
  const shutdown = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Swallow if it has already exited.
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  child.on("error", (e) => {
    process.stderr.write(
      `Failed to start the server binary (${serverBin}): ${e.message}\n`,
    );
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(launchFailed ? 1 : (code ?? 0)));

  const healthy = await pollUntil(
    () => checkHealth(port),
    SPAWN_HEALTH_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
  if (!healthy) {
    process.stderr.write(
      `The server did not start within ${SPAWN_HEALTH_TIMEOUT_MS / 1000}s.` +
        `\nFix: run \`${serverBin}\` directly to inspect the startup logs.\n`,
    );
    launchFailed = true;
    shutdown();
    return;
  }

  const url = initialUrl(`http://127.0.0.1:${port}`, token);
  process.stdout.write(`zashiki: ${url}\n`);
  if (open) {
    openBrowser(url);
  }
  // Stay resident as long as the child is alive (process.exit happens on the child's exit).
}

/** The git_sha of the server binary this CLI would spawn (via `zashiki-server build-id`). Null when it can't be determined (no basis to judge staleness). */
function expectedServerGitSha() {
  let serverBin;
  try {
    serverBin = resolveServerBin({
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      requireResolve: createRequire(import.meta.url).resolve,
    });
  } catch {
    return null;
  }
  try {
    const out = execFileSync(serverBin, ["build-id"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return healthzField(out, "git_sha");
  } catch {
    return null;
  }
}

/**
 * A running server occupies the port. Decide whether to ride along, or whether it is a stale build
 * (a client/server version skew that makes it reject the client's newer messages, #364) that we must
 * reclaim before spawning our own. Returns "reuse" (adopt it) or "reclaimed" (port freed → spawn ours).
 * Exits with an actionable message when a stale server cannot be reclaimed.
 */
async function ensureFreshResidentServer(port) {
  const health = await httpGet(port, "/healthz");
  if (health == null) {
    return "reclaimed"; // vanished between checkHealth and here → let spawn take the port
  }
  const decision = classifyReuse({
    expectedGitSha: expectedServerGitSha(),
    healthzBody: health.body,
  });
  if (decision === "reuse") {
    return "reuse";
  }
  const pid = healthzPid(health.body);
  if (pid == null) {
    process.stderr.write(
      `An outdated zashiki server is running on port ${port} but its pid is unknown, so it cannot be replaced automatically.\n` +
        "Fix: stop it and reinstall the daemon (bash scripts/install-daemon.sh), or use a different --port.\n",
    );
    process.exit(1);
  }
  process.stderr.write(
    `The server on port ${port} is outdated (build mismatch). Restarting it (pid ${pid})…\n`,
  );
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone; fall through to the release check.
  }
  const released = await pollUntil(
    async () => !(await checkHealth(port)),
    STALE_RELEASE_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
  if (!released) {
    process.stderr.write(
      `The outdated server on port ${port} did not release the port (a KeepAlive daemon may be respawning the same stale binary).\n` +
        "Fix: rebuild the server and reinstall the daemon (bash scripts/install-daemon.sh).\n",
    );
    process.exit(1);
  }
  return "reclaimed";
}

/** Entry point. Called from bin/zashiki.mjs. */
export async function run(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n\n`);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const port = resolvePort({ cliPort: args.port, env: process.env });

  if (await checkHealth(port)) {
    if ((await ensureFreshResidentServer(port)) === "reuse") {
      await adopt(port, args.open);
      return;
    }
    // "reclaimed": the stale server released the port → fall through and spawn our own fresh one.
  }
  await spawnServer(port, args.open);
}
