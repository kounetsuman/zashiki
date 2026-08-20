//! zashiki's core domain logic as pure, dependency-free (std-only) functions.
//!
//! Side-effect-free decision logic (`save_file` / `process_tree` / `git` / `session_state` /
//! `repos` / `flow` / `terminal_size`); `cargo test` is the canonical spec.

pub mod flow;
pub mod git;
pub mod process_tree;
pub mod repos;
pub mod save_file;
pub mod session_state;
pub mod terminal_size;
