[English](./README.md) | **日本語**

# crates/ — Rust 化（コアの Rust 移植）

Node server を撤去し、コアロジックを Rust へ寄せる取り組み。view（client）は TypeScript のまま。ここには「何のための crate か」という設計の骨子だけ置く。

## crate 構成

- **`zashiki-core`** … 純関数のみ・**依存ゼロ（std）を維持**。TS 版 `@zashiki/shared` の domain と 1:1 で対応する移植（`git` / `process_tree` / `save_file` / `session_state` / `repos` / `flow`）。`cargo test` で守り、CI `core-check` で TS 版との一致を担保する。
- **`zashiki-server`** … REST/WS/PTY・JSON シリアライズ・jsonl パースを持つ server crate（`axum` / `tokio` / `serde` 等に依存し `zashiki-core` を使う）。TS server の drop-in 置換を目指す。

## 目標アーキテクチャ

**独立 Rust server（常駐可）**。Node server を Rust server バイナリで置換し、Tauri は接続する（in-process link や FFI/napi は採らない = tmux 撤去後の常駐と両立せず、Node 同梱が残るため）。

## 段階移行

- **Phase A**: Rust server を Node の drop-in 置換にする。**client を無改修に保つ条件 = wire を不変に保つこと**（[`packages/shared/README.md`](../packages/shared/README.ja.md) の wire 契約）。tmux は Rust server が内包する。
- **Phase B**: tmux を撤去する。`portable-pty` 直管理 + ヘッドレス vterm で `capture-pane` を置換し、セッション永続化を launchd 常駐で自前化する。

順序: Rust server 成立（tmux 内包）→ tmux 撤去は Rust 側で一度だけ（TS で PTY 直管理を作り込む二重投資を避ける）。
