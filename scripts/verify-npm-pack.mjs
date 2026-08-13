//! Local end-to-end check of the published npm package zashiki.
//! client build -> bundle dist -> generate host binary -> pnpm pack -> extract tarball ->
//! launch the real CLI and verify /healthz, token-probe, and / (HTML serving).
//! Isolated via ZK_* so it never touches the real ~/.zashiki / ~/.claude/projects (same
//! approach as boot.mjs).
//! Runs to completion only when the host is darwin-arm64 / darwin-x64 (filling in the x64
//! binary is handled in release CI).

import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const HOST_PKG = {
  "darwin-arm64": "@zashiki/server-darwin-arm64",
  "darwin-x64": "@zashiki/server-darwin-x64",
}[`${process.platform}-${process.arch}`];

if (!HOST_PKG) {
  process.stderr.write(
    `this host (${process.platform}-${process.arch}) is not a supported target for the connectivity check. Run on macOS arm64 / x64.\n`,
  );
  process.exit(1);
}

function sh(cmd, args) {
  process.stdout.write(`$ ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function httpGet(port, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers,
    signal: AbortSignal.timeout(3_000),
  });
  return { status: res.status, body: await res.text() };
}

async function pollUntil(cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function extractTgz(tgz, destPkgDir) {
  mkdirSync(destPkgDir, { recursive: true });
  // The tarball's top level is package/. --strip-components 1 strips the package/ prefix.
  execFileSync("tar", [
    "-xzf",
    tgz,
    "-C",
    destPkgDir,
    "--strip-components",
    "1",
  ]);
}

const work = mkdtempSync(join(tmpdir(), "zashiki-pack-"));
process.stdout.write(`work directory: ${work}\n`);
let launcher = null;

try {
  // 1) workspace build (generate and bundle dist in shared->client->cli dependency order) -> generate host binary
  sh("pnpm", ["build"]);
  sh("node", ["scripts/build-npm-server-binary.mjs"]);

  // 2) pack (cli + host platform package)
  const packDir = join(work, "tgz");
  mkdirSync(packDir, { recursive: true });
  sh("pnpm", ["--filter", "zashiki", "pack", "--pack-destination", packDir]);
  sh("pnpm", ["--filter", HOST_PKG, "pack", "--pack-destination", packDir]);
  const tgzs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
  const cliTgz = join(
    packDir,
    tgzs.find((f) => f.startsWith("zashiki-0") || f === "zashiki.tgz") ??
      tgzs.find((f) => /^zashiki-\d/.test(f)),
  );
  const serverTgz = join(
    packDir,
    tgzs.find((f) => f.includes("server-darwin")),
  );

  // 3) Whether the cli tarball contains client-dist/index.html (kill the direct cause of a blank screen before packing)
  const listing = execFileSync("tar", ["-tzf", cliTgz], {
    encoding: "utf8",
  });
  if (!listing.includes("package/client-dist/index.html")) {
    throw new Error(
      `cli tarball does not contain client-dist/index.html:\n${listing}`,
    );
  }
  process.stdout.write("✓ confirmed client-dist/index.html in tarball\n");

  // 4) Extract into a node_modules layout (resolving optionalDependencies = exercising require.resolve for real)
  const nm = join(work, "node_modules");
  extractTgz(cliTgz, join(nm, "zashiki"));
  extractTgz(serverTgz, join(nm, HOST_PKG));

  // 5) Launch the real CLI in the isolated environment
  const isoDir = join(work, "iso");
  const savesDir = join(isoDir, "saves");
  const projectsRoot = join(isoDir, "projects");
  for (const d of [savesDir, projectsRoot]) mkdirSync(d, { recursive: true });
  const reposConf = join(isoDir, "repos.conf");
  writeFileSync(reposConf, `${join(isoDir, "acme")}\n`);
  mkdirSync(join(isoDir, "acme"), { recursive: true });

  const port = await freePort();
  const binPath = join(nm, "zashiki", "bin", "zashiki.mjs");
  launcher = spawn(
    process.execPath,
    [binPath, "--no-open", "--port", String(port)],
    {
      cwd: work,
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
      env: {
        ...process.env,
        ZK_TOKEN_FILE: join(isoDir, "token"),
        ZK_SAVES_DIR: savesDir,
        ZK_PROJECTS_ROOT: projectsRoot,
        ZK_CONFIG: join(isoDir, "config.json"),
        ZK_REPOS_CONF: reposConf,
        ZK_NO_CLAUDE: "1",
        ZK_POLL: "3600",
      },
    },
  );

  let stdout = "";
  launcher.stdout.on("data", (c) => {
    stdout += c.toString();
    process.stdout.write(c);
  });

  const healthy = await pollUntil(async () => {
    const r = await httpGet(port, "/healthz").catch(() => null);
    return r?.status === 200 && r.body.includes('"status":"ok"');
  }, 30_000);
  if (!healthy)
    throw new Error("server failed to start (no /healthz response)");
  process.stdout.write("✓ /healthz responded\n");

  // The launcher waits for healthz itself before emitting the token line. Since verify's
  // healthz detection can run ahead, poll until the token line appears (to avoid the race).
  await pollUntil(() => /\?token=([A-Za-z0-9]+)/.test(stdout), 10_000);
  const m = stdout.match(/\?token=([A-Za-z0-9]+)/);
  if (!m)
    throw new Error(`could not extract token from CLI output:\n${stdout}`);
  const token = m[1];

  const probe = await httpGet(port, "/api/zk-shell/token-probe", {
    "x-zashiki-token": token,
  });
  if (!(probe.status === 200 && probe.body.includes('"ok":true'))) {
    throw new Error(`token-probe not accepted: ${probe.status} ${probe.body}`);
  }
  process.stdout.write("✓ token-probe accepted the token\n");

  const root = await httpGet(port, "/");
  const head = root.body.trimStart().toLowerCase();
  if (
    !(
      root.status === 200 &&
      (head.startsWith("<!doctype html") || head.startsWith("<html"))
    )
  ) {
    throw new Error(`/ did not return HTML: ${root.status}`);
  }
  process.stdout.write("✓ / serves the bundled client dist (HTML)\n");

  process.stdout.write("\n✅ npm pack connectivity check: all items PASS\n");
} finally {
  if (launcher?.pid) {
    try {
      process.kill(-launcher.pid, "SIGTERM");
    } catch {
      // Already terminated.
    }
  }
  rmSync(work, { recursive: true, force: true });
}
