**English** | [日本語](./README.ja.md)

# @zashiki/desktop

Tauri 2.x desktop shell. On startup it manages the Rust server (`zashiki-server`)
as a sidecar, reads `~/.zashiki/token`, and injects it into the WebView's initial
URL via `?token=` (reusing the client's existing sessionStorage mechanism as-is; for
token verification see [`crates/README.md`](../../crates/README.md)).

## Prerequisites

- Rust stable (install via `rustup`; `rustc --version` must work)
- Node 22 / pnpm (shared across the repository)

## Running (development)

```sh
pnpm install
pnpm -F @zashiki/desktop dev   # = tauri dev
```

### Demo mode (for screen recordings)

```sh
pnpm -F @zashiki/desktop dev:demo
```

`dev:demo` (`scripts/dev-demo.mjs`) launches `tauri dev` against a throwaway,
isolated sandbox so you can hand-drive and screen-record the org cockpit **without
real Claude**: it auto-generates color-coded orgs and state-annotated sessions
(running / waiting_input / idle / no_claude, with titles) and never touches real
user data (`~/.zashiki` / `~/.claude`); the temp sandbox is removed on exit. It runs
on the same dev port (8790), so stop any running server first (it refuses to start if
8790 is already occupied). Edit the printed `demo-spec.json` and rerun with `--config
<path>` (or `ZASHIKI_DEMO_CONFIG`) to change the states/titles. This is a dev-only
affordance and is intentionally **not** part of the published `zashiki` CLI.

`tauri dev`, via `beforeDevCommand`, runs `cargo build` for the Rust server and
starts the Vite dev server (:5173, `VITE_ZK_SERVER=http://127.0.0.1:8790`), and the
shell then does the following:

1. Shows the window immediately (built-in loading page; startup runs in the background)
2. Checks whether the server is running at `http://127.0.0.1:8790/healthz`
3. If not running, spawns the `zashiki-server` binary in a dedicated process group
   (passing `ZK_PORT` / `ZK_TOKEN_FILE`; the server generates and writes the token on startup)
4. Reads `~/.zashiki/token` and confirms it is accepted via a real request (to detect
   a stale token; verification uses the 401/403 result against `/api/` — `GET /` is
   served statically and does not go through token verification)
5. Once ready, navigates the WebView to `http://localhost:5173/?token=…`

If startup fails, an error page (with remediation steps) is shown in the window, and
details appear on the terminal's stderr (the `[zashiki-shell +N.Ns]` progress log).
It does not return Err from setup (in Tauri v2 an Err from setup becomes an internal
panic, so it cannot unwind inside `did_finish_launching` and results in SIGABRT).

On shell exit (whether by closing the window / SIGTERM / Ctrl-C), **only the server
it spawned itself** is taken down via SIGTERM → 5s grace → SIGKILL to the process
group (it does not kill it when riding on an existing server). tmux is an independent
process, so the session remains.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ZK_PORT` | 8790 | server port (used for healthz / spawn / production initial URL) |
| `ZK_TOKEN_FILE` | `~/.zashiki/token` | location of the token file (the server generates and writes it / the sidecar reads it, also used for isolation during verification) |
| `ZK_SERVER_BIN` | `zashiki-server` in the same directory as the executable, otherwise `crates/zashiki-server/target/{release,debug}/zashiki-server` | the Rust server binary to spawn |
| `ZK_CLIENT_DIST` | distributed .app: `../Resources/client-dist` relative to the executable (bundled) / dev: `packages/client/dist` | the client dist for the server to serve statically. The sidecar passes it on spawn only when it actually exists (in dev it opens Vite:5173, so it is harmless even if not built) |
| `ZK_SHELL_URL` | dev: `http://localhost:5173` / build: `http://127.0.0.1:8790` | base of the WebView's initial URL |
| `ZK_CONFIG` | `~/.zashiki/config.json` | config file from which debug mode is read (shared with the server; see "Debug mode" below) |

## Debug mode (WebView devtools)

If you start with `debug` set to `true` in `~/.zashiki/config.json`, the WebView's
devtools (web inspector) are enabled, and you can open them by right-clicking the
window → "Inspect Element" (macOS; F12 is not bound by default in WKWebView, so open
it from the right-click menu).

```json
{ "debug": true }
```

- This `debug` is the same flag the server reads, and it is linked with the client's
  debug panel (a single "debug mode" enables both). The config file location can be
  overridden with `ZK_CONFIG`.
- It is read once at startup (changing the setting requires a restart). Missing,
  corrupt, or type-mismatched values fall back to `false` (devtools disabled).
- **dev (`tauri dev`) always has devtools enabled for the development experience.**
  What the setting gates is builds produced by `tauri build` (including the
  distributed .app and `tauri build --debug`). The dev determination is aligned with
  `tauri::is_dev()`, the same as the initial URL, so even a `--debug` build is
  correctly gated by config. To enable it in `tauri build` output, tauri's `devtools`
  feature is enabled (on macOS it uses private API, so it is not supported for App
  Store distribution; this app is distributed outside the App Store (Developer ID),
  so there is no practical impact).
- The canonical spec is `parse_debug_flag` / `devtools_enabled` in `src/sidecar.rs`
  (cargo test).

## Build

### Distribution build (a self-contained .app)

```sh
pnpm -F @zashiki/desktop build:app
```

`build:app` (`scripts/build-app.sh`) does the following end-to-end and produces a
`Zashiki.app` that can be placed in `/Applications` and runs independently of the
development tree:

1. Builds `@zashiki/shared` and `@zashiki/client` (the client is served by a
   same-origin server, so `VITE_ZK_SERVER` is not set = it connects relative to
   `window.location.origin`)
2. Builds `zashiki-server` in release mode
3. Places the sidecar's bundled artifacts into `src-tauri/` (generated, so already
   gitignored):
   - server → `src-tauri/binaries/zashiki-server-<target-triple>` (`externalBin`
     naming convention; in the `.app` it becomes `Contents/MacOS/zashiki-server`,
     matching the sidecar's sibling lookup)
   - client dist → `src-tauri/client-dist/` (via `bundle.resources` into
     `Contents/Resources/client-dist/`)
4. `tauri build` (`target/release/bundle/macos/Zashiki.app`)

On startup the sidecar spawns the bundled `zashiki-server` and points `ZK_CLIENT_DIST`
at `Contents/Resources/client-dist` (the server serves it statically, and the WebView
opens `http://127.0.0.1:8790`). It is not wired into the root `pnpm build` (to avoid
CI load).

In CI, a `vX.Y.Z` tag push has [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
place the bundled artifacts with the same `build-app.sh` (`--prepare-only`), delegate the actual
`tauri build` (`--bundles dmg`) to tauri-action, and publish `Zashiki.dmg` to a draft Release (macOS only).
The build is signed + notarized when the Apple secrets are configured, and falls back to unsigned
otherwise — see [Signing & notarization](#signing--notarization).

### Signing & notarization

Release builds are **code-signed with a Developer ID Application certificate and notarized**
when the Apple credentials are present as GitHub Actions secrets; the `.app`/`.dmg` then launch
without the Gatekeeper right-click workaround. When the secrets are absent (e.g. on a fork), the
build falls back to **unsigned** and the release still succeeds —
[`release.yml`](../../.github/workflows/release.yml) gates signing on the presence of
`APPLE_CERTIFICATE`.

During `tauri build` the Tauri bundler imports the certificate, signs the app and its bundled
`zashiki-server` sidecar (hardened runtime is on by default), notarizes via `notarytool`, and
staples the ticket; the workflow then verifies with `codesign --verify --deep --strict` and
`spctl -a -vvv`.

One-time setup (maintainer):

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) (paid) and
   create a **Developer ID Application** certificate. Export it from Keychain Access as a `.p12`
   (with a password), then base64-encode it: `base64 -i certificate.p12 | pbcopy`.
2. Create an **app-specific password** for your Apple ID at <https://account.apple.com> →
   Sign-In and Security, and note your 10-character **Team ID** from the Apple Developer account
   page.
3. Add these repository secrets (Settings → Secrets and variables → Actions):

   | Secret | Value |
   | --- | --- |
   | `APPLE_CERTIFICATE` | base64 of the exported `.p12` |
   | `APPLE_CERTIFICATE_PASSWORD` | password used when exporting the `.p12` |
   | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: NAME (TEAMID)` (from `security find-identity -v -p codesigning`) |
   | `APPLE_ID` | Apple ID email used for notarization |
   | `APPLE_PASSWORD` | the app-specific password from step 2 |
   | `APPLE_TEAM_ID` | 10-character Team ID |

Once a signed release is verified (`spctl -a -vvv Zashiki.app` reports *accepted*), drop the
"Unsigned / right-click → Open" note from the root [`README.md`](../../README.md) /
[`README.ja.md`](../../README.ja.md).

### Shell build that depends on the development tree

```sh
pnpm -F @zashiki/desktop build:shell            # = tauri build (no bundling)
pnpm -F @zashiki/desktop tauri build --debug --bundles app   # CI/verification equivalent
```

> `build:shell` does not stage the sidecar's bundled artifacts, so the resulting
> `.app` **assumes it is launched from the development tree** (`default_server_bin` /
> `default_client_dist` in `sidecar.rs` fall back to repository-relative outputs, so
> placing it alone in `/Applications` will not work). If you want it self-contained,
> use `build:app`.

Rust unit tests (health-check determination, token reading, URL assembly, bundled-artifact path resolution):

```sh
pnpm -F @zashiki/desktop test:rust   # = cargo test
```

## Manual smoke procedure (shell smoke is manual, not automated)

Because it touches real tmux / real `~/.zashiki`, a human performs it.

1. Start the shell with `pnpm build && pnpm -F @zashiki/desktop dev`
2. The terminal UI appears in the window (you are not asked to enter a token =
   token injection is working)
3. Open a window from the session list and confirm that keystrokes reach the terminal
4. Close the shell's window to exit
5. In daemon (launchd) operation, after the shell exits the server stays alive under
   `launchctl list io.github.kounetsuman.zashiki`, and `curl -s http://127.0.0.1:8790/healthz`
   stays 200 (claude does not die)
6. Start the server by hand first
   (`cargo run --manifest-path crates/zashiki-server/Cargo.toml`) → start the shell →
   exit the shell → `curl -s http://127.0.0.1:8790/healthz` stays 200
   (when riding on it, the server must not be killed)
7. **Self-contained distributed .app smoke**: build with
   `pnpm -F @zashiki/desktop build:app` and copy
   `target/release/bundle/macos/Zashiki.app` to `/Applications`.
   Launch it from outside the development tree (e.g., `cd /` and then
   `open /Applications/Zashiki.app`); the sidecar spawns the bundled `zashiki-server`
   → the terminal UI appears in the window (confirming that static serving of the
   bundled client dist works). The bundled artifact placement can be verified via
   `Contents/MacOS/zashiki-server` and `Contents/Resources/client-dist/index.html`.

## Uninstall

Run from the repository root (the script itself is `scripts/uninstall.sh`):

```sh
pnpm uninstall:app                            # dry run (default; deletes nothing)
pnpm uninstall:app -- --yes                   # deletes the app, build artifacts, and items under ~/Library
pnpm uninstall:app -- --yes --purge-user-data # the above + also deletes ~/.zashiki
```

- **The default is a dry run.** It only displays the deletion targets
  (`/Applications/Zashiki.app`, `target/release/bundle/`, `dist/Zashiki.app`, and
  `io.github.kounetsuman.zashiki`-related items under `~/Library`) and deletes nothing.
  Actual deletion requires `--yes`.
- **User data `~/.zashiki/` (`repos.conf` / `saves/` / `token`) is deleted only when
  `--purge-user-data` is given** (protected by default).
- The launchd daemon (LaunchAgent `io.github.kounetsuman.zashiki`) is unloaded and its plist
  deleted when `--yes` is given.

## Known limitations

- **Distributed builds are unsigned until the Apple signing secrets are configured**:
  without them the `.app` produced by `build:app` triggers a Gatekeeper warning on
  first launch (right-click → Open, etc. is required). Configure the secrets to enable
  signing + notarization — see [Signing & notarization](#signing--notarization).
- **Riding on an existing server that does not serve client dist**: the distributed
  .app opens `http://127.0.0.1:8790` (the server's `/`). If another server is already
  running on 8790, it rides on it, but if that server was not started with
  `ZK_CLIENT_DIST` (e.g., `tauri dev` / `cargo run` without dist), it cannot serve
  `/`. In this case it shows **an error page with remediation instead of a blank
  screen** (`start()` probes whether `/` can be served, and if not, returns a message
  to "quit the dev server and relaunch"). Remediation: quit the dev server occupying
  8790 and relaunch Zashiki.app. When distributed .app instances launch against each
  other, or launch from a not-running state, the problem does not occur because the
  server they spawn is given the client dist.
- **`build:shell` alone cannot be distributed**: because it does not stage the
  bundled artifacts, it falls back to the in-repo cargo output
  (`crates/zashiki-server/target/{release,debug}/zashiki-server`) and
  `packages/client/dist` (assuming a development machine). To make it self-contained,
  use `build:app`.
- **If you kill -9 the shell**, an already-spawned server is left behind as an orphan
  (graceful shutdown happens only on normal exit / SIGTERM/SIGINT). On the next shell
  startup it is detected via healthz and ridden on, so there is no double start. To
  take it down by hand, use `pkill -f 'server/dist/index.js'`.
- **`tauri dev` assumes `ZK_PORT=8790`**: because `beforeDevCommand`'s
  `VITE_ZK_SERVER=http://127.0.0.1:8790` is fixed, if you change the port in dev you
  also need to match it in tauri.conf.json (in a build it follows `ZK_PORT`).
- The definition of green in an environment where the GUI does not launch goes up to
  `cargo check` / `cargo test` / `tauri build --debug` (actual GUI confirmation is the
  manual smoke above).
