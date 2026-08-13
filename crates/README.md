**English** | [日本語](./README.ja.md)

# crates/ — Rustification (Rust port of the core)

An effort to remove the Node server and move the core logic into Rust. The view (client) stays in TypeScript. This directory holds only the skeleton of the design — "what each crate is for."

## Crate layout

- **`zashiki-core`** … Pure functions only, **kept dependency-free (std)**. A port corresponding 1:1 to the domain of the TS `@zashiki/shared` (`git` / `process_tree` / `save_file` / `session_state` / `repos` / `flow`). Guarded by `cargo test`, with the CI `core-check` ensuring parity with the TS version.
- **`zashiki-server`** … A server crate that holds REST/WS/PTY, JSON serialization, and jsonl parsing (depends on `axum` / `tokio` / `serde` etc. and uses `zashiki-core`). Aims to be a drop-in replacement for the TS server.

## Target architecture

**A standalone Rust server (able to run as a daemon).** The Node server is replaced by a Rust server binary, and Tauri connects to it (we do not adopt an in-process link or FFI/napi = it does not coexist with running as a daemon after tmux removal, and it would leave Node bundled).

## Phased migration

- **Phase A**: Make the Rust server a drop-in replacement for Node. **The condition for keeping the client unchanged = keeping the wire invariant** (the wire contract in [`packages/shared/README.md`](../packages/shared/README.md)). tmux is embedded within the Rust server.
- **Phase B**: Remove tmux. Replace `capture-pane` with direct `portable-pty` management + a headless vterm, and implement session persistence ourselves via a launchd daemon.

Order: establish the Rust server (tmux embedded) → remove tmux only once, on the Rust side (avoiding the double investment of building out direct PTY management in TS).
