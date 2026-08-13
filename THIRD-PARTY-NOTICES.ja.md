[English](./THIRD-PARTY-NOTICES.md) | **日本語**

# サードパーティ ライセンス表記

zashiki は多数のオープンソースソフトウェアに依存しています。本ファイルは、依存関係の
ライセンス構成の要約と、特に注意が必要な義務（弱コピーレフト等）を記載します。
各依存のライセンス全文は、下記「完全な一覧の生成」の手順で出力できます。

## 監査結果（2026-08-06 時点）

- **npm 依存**: 約 220 パッケージ。**すべて permissive**（MIT / Apache-2.0 / ISC / BSD-2/3-Clause / CC0-1.0 / MIT-0 / Unicode 等）。強コピーレフト（GPL / AGPL）は **なし**。
- **Rust 依存**: 約 468 crate。大半が `MIT OR Apache-2.0` 等の permissive。強コピーレフト（GPL / AGPL）は **なし**。

本プロジェクト（MIT）でのソース公開・バイナリ配布に、ライセンス上の支障はありません。

### 注意が必要な依存（弱コピーレフト: MPL-2.0）

以下の crate は MPL-2.0（**ファイル単位**の弱コピーレフト）です。**当該ファイルを改変しない限り**、
本プロジェクトでの利用・バイナリ配布に問題はありません（改変した場合は、改変した MPL ファイルの
ソースを開示する義務が生じます。プロジェクト全体を MPL 化する義務はありません）。

- `cssparser` / `cssparser-macros` / `selectors` / `dtoa-short`（Servo 由来。Tauri の WebView / スタイル解決経由）
- `option-ext`（`dirs` 経由）

### デュアルライセンスで MIT を選択している依存

- `r-efi`（`MIT OR Apache-2.0 OR LGPL-2.1-or-later` → **MIT を選択**。LGPL の義務は発生しない）

## 完全な一覧の生成

リリース時には、以下で各依存のライセンス全文を含む完全な notice を生成できます。

```sh
# Rust（いずれか）
cargo install cargo-about && cargo about generate > third-party-rust.txt
# または cargo install cargo-bundle-licenses && cargo bundle-licenses --format toml

# npm
pnpm licenses list            # サマリ
pnpm licenses list --json     # 機械可読（各パッケージ）
```

> 注: 依存は更新で変わるため、この要約は監査時点のもの。公開・リリース時に再監査すること。
