[English](./README.md) | **日本語**

# @zashiki/shared

オニオンアーキテクチャの最内核。**副作用ゼロの純関数**（domain）と、**client / server 両端で共有するプロトコル型**（zod）だけを置く。tmux・fs・ネットワークを知らない。

依存方向は `shared（domain）← server/usecase ← server/infra` / `client（presentation）`。この package は誰にも依存せず、単体テスト（Vitest）の主戦場になる。

## 仕様の正本はテスト

各モジュールの**振る舞いの正本は隣の `*.test.ts`**。設計判断はコード（命名・型・構造）と、必要な箇所のインラインコメントで表す。以下は「どのテストを読めば仕様が分かるか」の地図。

| モジュール | 役割 | 仕様の正本 |
|---|---|---|
| `session-state.ts` | capture テキスト等から状態（`waiting_input`/`running`/`running_bg_agent`/`idle`/`no_claude`）を判定する純関数。優先順・ウィザード検出・スピナー/bg エージェント検出 | `session-state.test.ts`（通常幅 + 80 桁折返しの capture フィクスチャによる表テスト） |
| `protocol.ts` | 制御メッセージ（`ClientMessage`/`ServerMessage`）と `SessionInfo` の zod スキーマ | `protocol.test.ts` |
| `repos.ts` | `repos.conf` 互換パーサ + org 配色（`orgColor`/`resolveOrgColor`/`DEFAULT_ORG_PALETTE`） | `repos.test.ts` |
| `git.ts` | `git status --porcelain` パーサ | `git.test.ts` |
| `process-tree.ts` | ps 出力からプロセス木を組み `--session-id` でペインを引く | `process-tree.test.ts` |
| `save-file.ts` | save/restore の TSV（`widx\twname\tcwd\tsid`）シリアライズ/パース | `save-file.test.ts` |
| `fs-tree.ts` | explorer 表示整形（`sortFsEntries`/`joinRepoRelative`/`fileIconKind`） | `fs-tree.test.ts` |
| `search.ts` | ripgrep 引数組み立て・`rg --json` 出力パース | `search.test.ts` |
| `session-state.ts`/`flow.ts` | 状態遷移・フロー制御の純ロジック | 各 `*.test.ts` |
| `config.ts` | 即反映/再起動要設定のスキーマ・デフォルト補完（パースは throw せず既定へ倒す） | `config.test.ts` |
| `notifications.ts` | アプリ内通知データ（`{id,level,title,body,createdAt,sticky,dismissible}`）と upsert | `notifications.test.ts` |
| `terminal-size.ts` | 端末サイズの実用下限クランプ（`isUsableTerminalSize` 等） | `terminal-size.test.ts` |
| `jsonl.ts` | `~/.claude/projects/**/*.jsonl` 末尾イベント/タイトル抽出 | `jsonl.test.ts` |

## プロトコル（wire）契約 — server 実体差し替えの不変条件

`protocol.ts` の型は **server 実装（Node / Rust）を差し替えても client を無改修に保つための契約**。crate `zashiki-server` はこの wire とバイト等価な JSON を返す（Rust 側 wire 型で担保）。不変に保つべき点:

- `/ws/control`（制御 JSON）のメッセージ形状。`term.ack` の bytes は **UTF-16 コード単位**（xterm.js が書き込む JS 文字列長 = client 側 watermark と一致させる）。
- `/ws/term/<termId>`（PTY 生バイナリ・フレーミング無し）。
- REST（`/api/git/*`・`/api/fs/*`・`/api/search`・`/api/file`）と `/healthz`。
- トークン検証（`x-zashiki-token` / `?token=`）と Host/Origin 検証。
- `state.sync` の `SessionInfo` 形状。

tmux の有無や PTY 管理戦略は wire の外側の実装詳細で、client には不可視。
