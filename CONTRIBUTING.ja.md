[English](./CONTRIBUTING.md) | **日本語**

# コントリビューションガイド

zashiki への貢献に興味を持っていただきありがとうございます。バグ報告・機能提案・Pull Request を歓迎します。

## はじめに

- バグ・要望は、まず [Issue](../../issues) を立ててください（関連する既存 Issue があればそちらへ）。
- **セキュリティ脆弱性は公開 Issue に書かず**、[SECURITY.md](./SECURITY.ja.md) の手順で非公開に報告してください。
- 参加にあたっては [行動規範（CODE_OF_CONDUCT.md）](./CODE_OF_CONDUCT.ja.md) に従ってください。

## 開発環境

前提: Node.js 22+ / pnpm / Rust (stable)。

```sh
pnpm install
pnpm -F @zashiki/desktop dev   # Tauri シェル（= tauri dev）
```

## コミット前のゲート

Pull Request を出す前に、ローカルで必ず通してください。

```sh
# TypeScript 側
pnpm build && pnpm lint && pnpm test

# Rust 側（該当を変更した場合）
cargo test --manifest-path crates/zashiki-core/Cargo.toml --locked
cargo test --manifest-path crates/zashiki-server/Cargo.toml --locked
```

## Pull Request の流れ

1. 対応する Issue を用意する（無ければ立てる）。
2. ブランチを切って作業する。
3. 変更はテストで守る（仕様はテストコードが正本）。
4. ゲートを green にしてから PR を出す。作業中は draft、レビュー可能になったら ready にする。
5. PR 本文に対象 Issue（`Closes #<issue>` など）を記載する。

## コーディング規約

- コミットメッセージ: `gitmoji #<issue番号> 概要1行`（例: `✨ #<issue> セッション一覧のソートを追加`）。
- コメント・テスト・ドキュメントの方針は [CLAUDE.md](./CLAUDE.md) を参照。
- 仕様はテストコード（`*.test.ts` / `cargo test`）が正本。振る舞いを変えるなら、まずテストを更新する。

## バージョニング

リリースは `vX.Y.Z` タグで公開する（形式はリリースワークフローが強制）。zashiki は API 利用者を持つライブラリではなく配布アプリなので、pre-1.0 の間は方針を意図的に単純にし、バージョンをほぼリリースカウンタとして扱う:

- **MINOR**（`0.Y.0`）— 通常リリースは毎回 MINOR を +1 し、PATCH を `0` に戻す。中身の分類は不要。
- **PATCH**（`0.Y.Z`）— 既出バージョンの hotfix / 再リリース限定（同じ機能セットを再配布するバグ修正・パッケージング修正）。
- **`1.0.0`** — UX と挙動を安定と宣言する時に昇格する。破壊的変更の MAJOR バンプは `1.0.0` 以降のみ適用する。

バンプは個々の Issue でなく*リリース*の属性なので、タグ時に決める — Issue ごとの規則を集約する必要はない。

Issue ラベル（`enhancement` / `bug` / `documentation` / `refactor`）は changelog のグルーピング専用。任意であり、バージョン番号には**効かせない**。

## ライセンス

コントリビュートされたコードは、本リポジトリのライセンス（[MIT](./LICENSE)）の下で配布されることに同意したものとみなされます。
