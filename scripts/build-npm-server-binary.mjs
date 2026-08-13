//! cargo builds zashiki-server and places it into the bin/ of the platform package
//! (@zashiki/server-darwin-<arch>). The target is given as an argument (defaults to the host).
//!   node scripts/build-npm-server-binary.mjs [darwin-arm64|darwin-x64]
//! A target different from the host requires `rustup target add <triple>` (cross build).

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const manifest = join(repoRoot, "crates", "zashiki-server", "Cargo.toml");

const TARGETS = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    pkg: "server-darwin-arm64",
  },
  "darwin-x64": { triple: "x86_64-apple-darwin", pkg: "server-darwin-x64" },
};

const hostKey = `${process.platform}-${process.arch}`;
const key = process.argv[2] ?? hostKey;
const target = TARGETS[key];
if (!target) {
  process.stderr.write(
    `unsupported target: ${key} (${Object.keys(TARGETS).join(", ")})\n`,
  );
  process.exit(1);
}

const args = ["build", "--release", "--manifest-path", manifest];
let outDir = join(repoRoot, "crates", "zashiki-server", "target", "release");
if (key !== hostKey) {
  args.push("--target", target.triple);
  outDir = join(
    repoRoot,
    "crates",
    "zashiki-server",
    "target",
    target.triple,
    "release",
  );
}

process.stdout.write(`cargo ${args.join(" ")}\n`);
execFileSync("cargo", args, { stdio: "inherit" });

const built = join(outDir, "zashiki-server");
if (!existsSync(built)) {
  process.stderr.write(`build artifact not found: ${built}\n`);
  process.exit(1);
}

const destDir = join(repoRoot, "packages", target.pkg, "bin");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, "zashiki-server");
copyFileSync(built, dest);
chmodSync(dest, 0o755);
process.stdout.write(`placed: ${dest}\n`);
