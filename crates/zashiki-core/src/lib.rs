//! A crate porting zashiki's core logic (pure functions) to Rust (the first increment).
//!
//! A stepping stone toward "limit TypeScript to the view and move core logic into Rust".
//! First it ports the side-effect-free, dependency-free domain pure functions (`save_file` /
//! `process_tree` / `git` / `session_state` / `repos` / `flow`). They correspond 1:1 with the
//! TS version (`packages/shared/src/*.ts`), and the vitest table tests are ported to `cargo test` too.
//!
//! At this stage nothing is wired into the runtime (Tauri/Node) yet (non-destructive). Runtime
//! integration (turning it into a sidecar / FFI) and porting the remaining modules that need JSON
//! parsing (jsonl etc.) are done in subsequent increments.

pub mod flow;
pub mod git;
pub mod process_tree;
pub mod repos;
pub mod save_file;
pub mod session_state;
pub mod terminal_size;
