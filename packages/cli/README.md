**English** | [日本語](./README.ja.md)

# @zashiki/cli (CLI / published npm package)

The CLI itself, installed via `npm install -g @zashiki/cli`. The `zashiki` command starts the Rust server
(`zashiki-server`), has it serve the bundled client dist, and opens it in a browser. (Prefer a native
window? The same cockpit also ships as a desktop app — see the `Zashiki.dmg` release.)

```sh
npm install -g @zashiki/cli
zashiki                 # start server → open http://127.0.0.1:8790/?token=... in a browser
zashiki --port 9000     # change the port (default 8790 / env var ZK_PORT)
zashiki --no-open       # do not open a browser; just print the URL
```

## Structure

- `bin/zashiki.mjs` … Entry point. Calls `run()` in `src/launcher.mjs`.
- `src/launcher.mjs` … Startup orchestration (spawn / adopt / wait for healthz / open). This is a Node
  port of the source of truth, `apps/desktop/src-tauri/src/sidecar.rs` (the Tauri shell's startup sequence).
- `src/lib.mjs` … Pure functions (argument parsing, port/token validation, URL assembly, health checks).
  The spec's source of truth is `src/lib.test.mjs`.
- `client-dist/` … The build output of `@zashiki/client`, bundled by `build` (`scripts/copy-client-dist.mjs`).
  Served statically by the server as `ZK_CLIENT_DIST`. **Being included in the pack tarball** is the lifeline
  for avoiding a blank screen.

## Distribution of the server binary

`zashiki-server` is distributed as platform-specific packages under `optionalDependencies`
(`@zashiki/server-darwin-arm64` / `-x64`), and `npm` installs only the one matching the runtime.
The CLI resolves it via `require.resolve('@zashiki/server-<os>-<arch>/bin/zashiki-server')`
(`ZK_SERVER_BIN` takes top priority if present).

## Startup sequence (launcher)

1. Determine the effective port (`--port` > `ZK_PORT` > 8790).
2. If `/healthz` already returns OK, **adopt** the existing server (do not spawn, and do not shut it down on
   exit). In that case, verify that `/` returns HTML (client UI serving) and that the token-probe is accepted.
3. If not already running, spawn it, passing `ZK_CLIENT_DIST=bundled dist` and a self-generated `ZK_TOKEN`.
4. Wait for `/healthz` by polling, then open `http://127.0.0.1:PORT/?token=TOKEN` in a browser.
5. Forward `SIGINT`/`SIGTERM` to the child's process group for a graceful shutdown.

## Local connectivity check

At the repository root:

```sh
pnpm verify:npm-pack
```

Build the client → bundle the dist → generate the host binary → `pnpm pack` → extract the tarball →
launch the real CLI → verify `/healthz`, the token-probe, and `/` (HTML serving) in an isolated environment.

> Actual npm publish and the release CI (tag builds of per-platform binaries, x64 filling) are follow-up issues.
> The local connectivity check is self-contained using only the host (arm64) package.
