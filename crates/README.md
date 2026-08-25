**English** | [日本語](./README.ja.md)

# crates/ — Rustification (Rust port of the core)

An effort to remove the Node server and move the core logic into Rust. The view (client) stays in TypeScript. This directory holds only the skeleton of the design — "what each crate is for."

## Crate layout

- **`zashiki-core`** … Pure functions only, **kept dependency-free (std)**. A port corresponding 1:1 to the domain of the TS `@zashiki/shared` (`git` / `process_tree` / `save_file` / `session_state` / `repos` / `flow`). Guarded by `cargo test`, with the CI `core-check` ensuring parity with the TS version.
- **`zashiki-server`** … A server crate that holds REST/WS/PTY, JSON serialization, and jsonl parsing (depends on `axum` / `tokio` / `serde` etc. and uses `zashiki-core`). Aims to be a drop-in replacement for the TS server.

## Target architecture

**A standalone Rust server (able to run as a daemon).** The Node server is replaced by a Rust server binary, and Tauri connects to it (we do not adopt an in-process link or FFI/napi = it does not coexist with running as a daemon, and it would leave Node bundled).

## Design notes

- **The client stays unchanged** by **keeping the wire invariant** (the wire contract in [`packages/shared/README.md`](../packages/shared/README.md)).
- The server is the sole owner and reader of each session's PTY (`portable-pty`), reconstructing the visible screen with a headless vterm (`vt100`) instead of relying on an external multiplexer.
