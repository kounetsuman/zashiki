[English](./README.md) | **日本語**

# zashiki（座敷）

zashiki は Claude Code のオーケストレーションを、最高の UI/UX と共に 1 画面で捌く AI コックピット。

[![CI](https://github.com/kounetsuman/zashiki/actions/workflows/ci.yml/badge.svg)](https://github.com/kounetsuman/zashiki/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa)](https://github.com/sponsors/kounetsuman)
[![GitHub stars](https://img.shields.io/github/stars/kounetsuman/zashiki?style=social)](https://github.com/kounetsuman/zashiki/stargazers)

![zashiki のデモ](assets/demo.gif)

![セッション一覧のスクリーンショット](assets/screenshot.png)

## Quick Start

ワンライナー（Apple Silicon）— 最新リリースを Gatekeeper の警告なしで入れます:

```sh
curl -fsSL https://raw.githubusercontent.com/kounetsuman/zashiki/main/scripts/install.sh | bash
```

Homebrew（Apple Silicon）:

```sh
brew install --cask --no-quarantine kounetsuman/tap/zashiki
```

もしくは [Releases](https://github.com/kounetsuman/zashiki/releases) から macOS 向け `Zashiki_*.dmg` を入手し、開いて `Zashiki.app` を `/Applications` にドラッグします。

Zashiki を起動すると、Claude Code の各セッションが 1 つのウィンドウに集約されます。

> **未署名アプリ**: zashiki はまだ署名・notarize されていません（[#25](https://github.com/kounetsuman/zashiki/issues/25)）。ブラウザで DL した `.dmg` には `com.apple.quarantine` が付くため、macOS は **「Zashiki.app は壊れているため開けません」** と拒否します（右クリック →「開く」でも解除できません）。上記の `curl` インストーラは quarantine が付かないため回避でき、`brew` は `--no-quarantine` が必要です（上記）。既に quarantine 付きで入れてしまった場合は手動で剥がします:
>
> ```sh
> xattr -dr com.apple.quarantine /Applications/Zashiki.app
> ```

## 既存ツールとの比較

zashiki は「**エージェントを並列で走らせる**」系のツールではありません。それらは既にあり、得意です。zashiki はその**上のレイヤー**——自分のセッションの**どれが待ちか**を教え、Claude Code のオーケストレーションを最高の UI/UX で捌く 1 画面の AI コックピットです。

| | **zashiki** | Conductor | Claude Squad | Sculptor | 素の複数タブ |
|---|---|---|---|---|---|
| 全セッションを 1 画面で一望 | ✅ | ✅ | ✅ | ✅ | ❌ |
| **どれが待ちか**を教える | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ |
| 待ちを**通知**する | ✅ | ❌ | ❌ | ⚠️ | ❌ |
| 並列実行 / 作業隔離 | ⚠️（専門外） | ✅（worktree） | ✅ | ✅（コンテナ） | ⚠️ |
| セットアップ | ⚠️（alpha） | ✅ | ✅ | ⚠️ | ✅ |

> 2026-08 時点のベストエフォート。競合は速く進化します。誤りは issue / PR で歓迎——正直な比較表を置く意味はそこにあります。zashiki は「隔離」「セットアップ」の列を意図的に落としています。走らせることではなく、**既に走らせているセッションの可観測性**に特化しているからです。

---

## アーキテクチャ（概要）

```
Tauri WebView (xterm.js + UI)
    ↕ WebSocket
Server (Rust / zashiki-server)
    ↕ portable-pty（PTY を単一所有）+ ヘッドレス vt100
Claude Code（サーバが所有する PTY 上で動く）
```

- サーバが各セッションの PTY を単一所有し、ヘッドレス vt100 で画面を再構成する（tmux 非依存）
- セッション一覧はデーモン（launchd）起動時に `claude --resume` で永続化・復元される
- 状態（running / idle / waiting）を一覧表示し、waiting でデスクトップ通知が飛ぶ

## 開発セットアップ

前提: Node.js 22+ / pnpm / Rust (stable)。

```sh
pnpm install
pnpm -F @zashiki/desktop dev   # Tauri シェル（= tauri dev）
```

デスクトップシェル（環境変数・手動スモーク手順）は [`apps/desktop/README.md`](apps/desktop/README.md) を参照。

## ビルド / インストール

### 配布バイナリ

[Releases](https://github.com/kounetsuman/zashiki/releases) から macOS の `Zashiki_*.dmg` を取得し、マウントして `Zashiki.app` を `/Applications` にドラッグします。`vX.Y.Z` タグの push で [`.github/workflows/release.yml`](.github/workflows/release.yml) が走り、自己完結バンドルを draft Release として公開します。[Quick Start](#quick-start) のワンライナー `curl` インストーラは同じことを、下記の quarantine 問題なしで行います。

> **未署名**: ブラウザで DL した `.dmg` は quarantine が付くため、macOS は **「Zashiki.app は壊れている」** と表示します（右クリック → 「開く」でも解除不可）。`xattr -dr com.apple.quarantine /Applications/Zashiki.app` で剥がすか、[Quick Start](#quick-start) の `curl` インストーラ / `brew --no-quarantine` を使ってください。署名・notarize は [#25](https://github.com/kounetsuman/zashiki/issues/25) で追跡しています。

### ローカルでビルド

```sh
pnpm -F @zashiki/desktop build:app   # 自己完結の .app（scripts/build-app.sh）
pnpm -F @zashiki/desktop dev         # dev 起動（Tauri シェル）
```

`build:app` は `zashiki-server` を `externalBin`、クライアント dist を `bundle.resources` として同梱した `Zashiki.app` を生成します（`/Applications` から単体で動く）。`build:shell`（= 素の `tauri build`）は同梱せず開発ツリー前提のため配布には使いません。詳細と制約は [`apps/desktop/README.md`](apps/desktop/README.md) を参照。

## 現状の制約

- 配布 `.app` の同梱（externalBin）まわりは追跡中。

## アンインストール

```sh
pnpm uninstall:app                            # dry run（既定。何も消さない）
pnpm uninstall:app -- --yes                   # app・ビルド成果物・~/Library 下を削除
pnpm uninstall:app -- --yes --purge-user-data # 上記 + ~/.zashiki（repos.conf/saves/token）
```

**既定は dry run**（消す対象を表示するだけ）。実削除には明示的な `--yes` が必要です。**`~/.zashiki/` 下のユーザーデータ（保存セッション・トークン）は `--purge-user-data` を付けたときだけ削除**されます（既定では保護）。`--yes` で launchd デーモン（LaunchAgent）を unload し plist を削除します。スクリプトは [`scripts/uninstall.sh`](scripts/uninstall.sh)、デーモン導入は [`scripts/install-daemon.sh`](scripts/install-daemon.sh)。

## 設計・仕様・経緯の在り処

専用の `docs/` は持ちません。次の 3 本に一本化しています。

- **仕様はテストコード**（`*.test.ts` / `cargo test`）が正本。「この振る舞いはどう決まっているか」を知るにはテストを読む。
- **経緯は commit / Pull Request / issue** — 改訂ログ・PDCA・「なぜこの形になったか」。
- **設計は宣言的な実装と適切な抽象化**で表す。足りなければインラインコメント、ディレクトリ横断なら各ディレクトリの `README.md`。

主要 README:

| 場所 | 内容 |
|---|---|
| [`packages/shared`](packages/shared/README.md) | オニオン最内核（純関数 + プロトコル型）。ワイヤ契約 |
| [`packages/client`](packages/client/README.md) | UI クライアント（Tauri WebView）起動、手動チェックリスト |
| [`apps/desktop`](apps/desktop/README.md) | Tauri シェル、サイドカー、ビルド |
| [`crates`](crates/README.md) | Rust サーバ（`zashiki-server`）とコア。レイヤリング / セキュリティ / PTY 所有 / 保存復元 / 環境変数 |
| [`hooks`](hooks/README.md) / [`.githooks`](.githooks/README.md) | Claude Code フックの junction / 汚染防止フック |

この README が立脚するプロダクトのポジショニングは [`POSITIONING.md`](POSITIONING.md) を参照。

## コントリビュート

バグ報告・機能提案・Pull Request を歓迎します。

- コントリビュートガイド: [CONTRIBUTING.md](CONTRIBUTING.md)
- 行動規範: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- セキュリティ報告: [SECURITY.md](SECURITY.md)
- サードパーティライセンス表記: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## スポンサー

zashiki が役に立ったら、[GitHub Sponsors での支援](https://github.com/sponsors/kounetsuman) ❤ をご検討ください。メンテナンスと新機能開発の資金になります。

## ライセンス

[MIT](LICENSE) © Kotaro Sato
