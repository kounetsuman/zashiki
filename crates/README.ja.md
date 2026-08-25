[English](./README.md) | **日本語**

# crates/ — Rust 化（コアの Rust 移植）

Node server を撤去し、コアロジックを Rust へ寄せる取り組み。view（client）は TypeScript のまま。ここには「何のための crate か」という設計の骨子だけ置く。

## crate 構成

- **`zashiki-core`** … 純関数のみ・**依存ゼロ（std）を維持**。TS 版 `@zashiki/shared` の domain と 1:1 で対応する移植（`git` / `process_tree` / `save_file` / `session_state` / `repos` / `flow`）。`cargo test` で守り、CI `core-check` で TS 版との一致を担保する。
- **`zashiki-server`** … REST/WS/PTY・JSON シリアライズ・jsonl パースを持つ server crate（`axum` / `tokio` / `serde` 等に依存し `zashiki-core` を使う）。TS server の drop-in 置換を目指す。

## 目標アーキテクチャ

**独立 Rust server（常駐可）**。Node server を Rust server バイナリで置換し、Tauri は接続する（in-process link や FFI/napi は採らない = 常駐と両立せず、Node 同梱が残るため）。

## 設計方針

- **client を無改修に保つ**ため、**wire を不変に保つ**（[`packages/shared/README.md`](../packages/shared/README.ja.md) の wire 契約）。
- server が各セッションの PTY を単一所有・単一読み取りし（`portable-pty`）、外部マルチプレクサに頼らずヘッドレス vterm（`vt100`）で可視画面を再構成する。
