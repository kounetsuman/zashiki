//! Pure functions for the zashiki CLI (side-effect free, under test).
//! The source of truth for the startup sequence is apps/desktop/src-tauri/src/sidecar.rs.
//! This ports that crate's pure functions (is_healthy_response / serves_client_ui /
//! is_html_document / read_token / verify_token / initial_url) to Node, keeping the
//! contract (body strings, alphanumeric tokens) aligned.

import { join } from "node:path";

/** Server default port (matches sidecar.rs DEFAULT_PORT / server main.rs). */
export const DEFAULT_PORT = 8790;

/** Mapping of distributable platforms to their platform package name. */
const SERVER_PACKAGE_BY_PLATFORM = {
  "darwin-arm64": "@zashiki/server-darwin-arm64",
  "darwin-x64": "@zashiki/server-darwin-x64",
};

/**
 * Returns the platform package name for `process.platform`-`process.arch`.
 * Returns null for unsupported combinations.
 */
export function platformPackageName(platform, arch) {
  return SERVER_PACKAGE_BY_PLATFORM[`${platform}-${arch}`] ?? null;
}

/**
 * Resolves the path to the zashiki-server binary.
 * Precedence: ZK_SERVER_BIN > the platform package's bin/zashiki-server.
 * requireResolve injects `createRequire(import.meta.url).resolve` (swappable for tests).
 * Throws an actionable error for unsupported platforms or a missing package.
 */
export function resolveServerBin({ env = {}, platform, arch, requireResolve }) {
  if (env.ZK_SERVER_BIN) {
    return env.ZK_SERVER_BIN;
  }
  const pkg = platformPackageName(platform, arch);
  if (!pkg) {
    throw new Error(
      `Unsupported platform (${platform}-${arch}). Only macOS arm64 / x64 are supported. ` +
        "On other environments, set ZK_SERVER_BIN to the path of the zashiki-server binary.",
    );
  }
  try {
    return requireResolve(`${pkg}/bin/zashiki-server`);
  } catch {
    throw new Error(
      `${pkg} not found. Reinstall zashiki, or ` +
        "set ZK_SERVER_BIN to the path of the zashiki-server binary.",
    );
  }
}

/**
 * Parses CLI arguments. Side-effect free, pure function.
 * Supports: --port <n> / --port=<n> / -p, --no-open, --help/-h, --version/-v.
 */
export function parseArgs(argv) {
  const result = {
    port: null,
    open: true,
    help: false,
    version: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--no-open") {
      result.open = false;
    } else if (arg === "--port" || arg === "-p") {
      const parsed = parsePort(argv[++i]);
      if (parsed == null) {
        result.error = `Invalid value for --port: ${argv[i] ?? ""}`;
      } else {
        result.port = parsed;
      }
    } else if (arg.startsWith("--port=")) {
      const parsed = parsePort(arg.slice("--port=".length));
      if (parsed == null) {
        result.error = `Invalid value for --port: ${arg.slice("--port=".length)}`;
      } else {
        result.port = parsed;
      }
    } else {
      result.error = `Unknown argument: ${arg}`;
    }
  }
  return result;
}

/** Returns a number for an integer string in 1..65535, otherwise null. */
function parsePort(value) {
  if (value == null || value === "") {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return null;
  }
  return n;
}

/**
 * Determines the token file path per port.
 * The default port uses ~/.zashiki/token (the same canonical path as the daemon /
 * Tauri sidecar); other ports are isolated to token-<port> so that launching on a
 * custom port does not pollute the default port's token.
 * When ZK_TOKEN_FILE is set explicitly it takes highest precedence (isolated
 * injection for e2e / tests).
 */
export function tokenFilePath({ port, env = {}, home }) {
  if (env.ZK_TOKEN_FILE) {
    return env.ZK_TOKEN_FILE;
  }
  const dir = join(home, ".zashiki");
  return join(dir, port === DEFAULT_PORT ? "token" : `token-${port}`);
}

/**
 * Determines the effective port. Precedence: CLI flag > ZK_PORT > default (8790).
 * Falls back to the default if ZK_PORT is invalid.
 */
export function resolvePort({
  cliPort = null,
  env = {},
  fallback = DEFAULT_PORT,
}) {
  if (cliPort != null) {
    return cliPort;
  }
  const fromEnv = parsePort(env.ZK_PORT);
  if (fromEnv != null) {
    return fromEnv;
  }
  return fallback;
}

/**
 * Validates and returns the raw token file string (port of sidecar.rs read_token).
 * Trimmed, non-empty, alphanumeric only. Rules out URL injection via a scheme that
 * needs no encoding.
 */
export function readToken(raw) {
  const token = (raw ?? "").trim();
  if (token === "") {
    throw new Error("The token is empty");
  }
  if (!/^[A-Za-z0-9]+$/.test(token)) {
    throw new Error(
      "The token content is invalid (contains non-alphanumeric characters)",
    );
  }
  return token;
}

/**
 * Builds the initial URL (port of sidecar.rs initial_url).
 * The token needs no encoding since readToken/generateToken guarantee it is
 * alphanumeric only.
 */
export function initialUrl(base, token) {
  return `${base}/?token=${token}`;
}

/** Whether /healthz belongs to a running server (sidecar.rs is_healthy_response). */
export function isHealthyResponse(status, body) {
  return status === 200 && body.includes('"status":"ok"');
}

/**
 * Whether the token-probe accepted the token (sidecar.rs verify_token body contract).
 * Checks not only status 200 but also that the body contains `"ok":true` (to avoid
 * misreading a catch-all 200).
 */
export function isTokenAccepted(status, body) {
  return status === 200 && body.includes('"ok":true');
}

/** Whether `/` is an HTML document (sidecar.rs is_html_document). Rejects piggybacking when the client dist is not served. */
export function isHtmlDocument(body) {
  const head = body.trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Extracts a top-level string field from a healthz / build-id JSON body (sidecar.rs healthz_str_field). Null on any failure. */
export function healthzField(body, key) {
  try {
    const value = JSON.parse(body)?.[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The server's own pid as declared by healthz (sidecar.rs healthz_pid). Null for old servers that
 * don't return it. pid <= 0 is rejected: on POSIX, kill(0/-n) signals a process group / everything,
 * so this structurally prevents self-destruction from a corrupt healthz.
 */
export function healthzPid(body) {
  const pid = (() => {
    try {
      return JSON.parse(body)?.pid;
    } catch {
      return null;
    }
  })();
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Given a healthy /healthz body ([`isHealthyResponse`]==true) and the git_sha of the binary this CLI
 * would spawn, decides whether it is OK to ride along on the running server. Port of
 * apps/desktop/src-tauri/src/sidecar.rs `classify_reuse` (canonical), using git_sha because all
 * packages ship version 0.0.0 (git_sha is the only skew signal).
 * - expectedGitSha absent / "unknown": no basis to judge → "reuse".
 * - healthz git_sha equals expected → "reuse".
 * - mismatch, or git_sha missing (an old server predating the build id) → "stale".
 */
export function classifyReuse({ expectedGitSha, healthzBody }) {
  if (!expectedGitSha || expectedGitSha === "unknown") {
    return "reuse";
  }
  const sha = healthzField(healthzBody, "git_sha");
  return sha != null && sha === expectedGitSha ? "reuse" : "stale";
}
