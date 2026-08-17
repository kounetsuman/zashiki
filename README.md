**English** | [日本語](./README.ja.md)

# zashiki (座敷)

zashiki is an AI cockpit that orchestrates Claude Code on one screen, with best-in-class UI/UX.

[![CI](https://github.com/kounetsuman/zashiki/actions/workflows/ci.yml/badge.svg)](https://github.com/kounetsuman/zashiki/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa)](https://github.com/sponsors/kounetsuman)
[![GitHub stars](https://img.shields.io/github/stars/kounetsuman/zashiki?style=social)](https://github.com/kounetsuman/zashiki/stargazers)

![zashiki demo](assets/demo.gif)

![Screenshot of the session list](assets/screenshot.png)

## Quick Start

Homebrew (Apple Silicon):

```sh
brew install --cask kounetsuman/tap/zashiki
```

Or grab the macOS `Zashiki_*.dmg` from [Releases](https://github.com/kounetsuman/zashiki/releases), open it, and drag `Zashiki.app` into `/Applications`.

Launch Zashiki and every Claude Code session shows up in one window.

> **Unsigned**: on first launch, right-click → "Open" to get past Gatekeeper.

## How zashiki compares

zashiki is **not** another "run a bunch of agents in parallel" tool. Those already exist and are good at it. zashiki is the **layer on top**: the one-screen AI cockpit that tells you *which* of your sessions is waiting and makes orchestrating Claude Code effortless with best-in-class UI/UX.

| | **zashiki** | Conductor | Claude Squad | Sculptor | Raw terminal tabs |
|---|---|---|---|---|---|
| Every session on one screen | ✅ | ✅ | ✅ | ✅ | ❌ |
| Tells you **which one is waiting** | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ |
| **Notifies** you when one needs you | ✅ | ❌ | ❌ | ⚠️ | ❌ |
| Parallel run / workspace isolation | ⚠️ (not the focus) | ✅ (worktrees) | ✅ | ✅ (containers) | ⚠️ |
| Setup | ⚠️ (alpha) | ✅ | ✅ | ⚠️ | ✅ |

> Best-effort as of 2026-08; competitors evolve fast. Corrections via issue/PR are welcome — that's the point of an honest table. zashiki deliberately loses the "isolation" and "setup" columns: it specializes in *observability of the sessions you already run*, not in running them.

---

## Architecture (overview)

```
Tauri WebView (xterm.js + UI)
    ↕ WebSocket
Server (Rust / zashiki-server)
    ↕ portable-pty (sole PTY ownership) + headless vt100
Claude Code (runs on a PTY owned by the server)
```

- The server solely owns each session's PTY and reconstructs the screen with a headless vt100 (no tmux dependency)
- The session list is persisted and restored via `claude --resume` when the daemon (launchd) starts
- State (running / idle / waiting) is shown in a list; waiting fires a desktop notification

## Setup (development)

Prerequisites: Node.js 22+ / pnpm / Rust (stable).

```sh
pnpm install
pnpm -F @zashiki/desktop dev   # Tauri shell (= tauri dev)
```

For the desktop shell (environment variables, manual smoke-test steps), see [`apps/desktop/README.md`](apps/desktop/README.md).

## Build / Install

### Distributable binary

Grab the macOS `Zashiki_*.dmg` from [Releases](https://github.com/kounetsuman/zashiki/releases), mount it, and drag `Zashiki.app` into `/Applications`. Pushing a `vX.Y.Z` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds a self-contained bundle and publishes it as a draft Release.

> **Unsigned**: on first launch, right-click → "Open" to get past Gatekeeper.

### Build it locally

```sh
pnpm -F @zashiki/desktop build:app   # self-contained .app (scripts/build-app.sh)
pnpm -F @zashiki/desktop dev         # dev launch (Tauri shell)
```

`build:app` produces a `Zashiki.app` that bundles `zashiki-server` as `externalBin` and the client dist as `bundle.resources` (runs standalone from `/Applications`). `build:shell` (= plain `tauri build`) does not bundle these and assumes the development tree, so it is not used for distribution. For details and constraints, see [`apps/desktop/README.md`](apps/desktop/README.md).

## Current constraints

- The distributed `.app` bundling story (externalBin) is a work in progress.

## Uninstall

```sh
pnpm uninstall:app                            # dry run (default; deletes nothing)
pnpm uninstall:app -- --yes                   # delete the app, build artifacts, and files under ~/Library
pnpm uninstall:app -- --yes --purge-user-data # the above + ~/.zashiki (repos.conf/saves/token)
```

**The default is a dry run**: it only prints what would be deleted. Actual deletion requires an explicit `--yes`. **User data under `~/.zashiki/` (saved sessions and tokens) is deleted only with `--purge-user-data`** (protected by default). With `--yes`, the launchd daemon (LaunchAgent) is unloaded and its plist removed. The script is [`scripts/uninstall.sh`](scripts/uninstall.sh); the daemon is installed by [`scripts/install-daemon.sh`](scripts/install-daemon.sh).

## Where design, spec, and history live

There is no dedicated `docs/`. Everything is consolidated into three sources:

- **The spec is the test code** (`*.test.ts` / `cargo test`) — the source of truth. To understand "how is this behavior decided," read the tests.
- **The history is in commits / Pull Requests / issues** — change logs, PDCA, and "why did it end up this way."
- **The design is expressed through declarative implementation and appropriate abstraction.** When that is not enough, use inline comments; when it spans directories, use each directory's `README.md`.

Main READMEs:

| Location | Contents |
|---|---|
| [`packages/shared`](packages/shared/README.md) | Innermost onion core (pure functions + protocol types). The wire contract |
| [`packages/client`](packages/client/README.md) | UI client (Tauri WebView) launch, manual checklist |
| [`apps/desktop`](apps/desktop/README.md) | Tauri shell, sidecar, build |
| [`crates`](crates/README.md) | Rust server (`zashiki-server`) and core. Layering / security / PTY ownership / save-restore / env vars |
| [`hooks`](hooks/README.md) / [`.githooks`](.githooks/README.md) | Claude Code hook junction / contamination-prevention hooks |

See [`POSITIONING.md`](POSITIONING.md) for the product positioning this README is built on.

## Contributing

Bug reports, feature proposals, and Pull Requests are welcome.

- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Third-party license notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## Sponsor

If zashiki is useful to you, please consider [sponsoring on GitHub Sponsors](https://github.com/sponsors/kounetsuman) ❤ — it directly funds maintenance and new features.

## License

[MIT](LICENSE) © Kotaro Sato
