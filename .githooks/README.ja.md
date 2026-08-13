[English](./README.md) | **日本語**

# .githooks — コンタミ防止フック

秘密情報・社内固有語・PII を「入る前」に止めるためのバージョン管理された git フック群。
`core.hooksPath` で有効化するため、clone した contributor も同じ防御を得る。

## セットアップ

`pnpm install` 時に `package.json` の `prepare` が自動で設定する。手動なら:

```bash
git config core.hooksPath .githooks
brew install gitleaks   # 未導入の場合
```

## フック一覧

| フック | 対象 | 手段 |
|---|---|---|
| `pre-commit` | staged 差分 | `gitleaks git --staged` ＋社内語 denylist |
| `commit-msg` | コミットメッセージ | `gitleaks stdin` ＋ denylist |
| `pre-push` | push するコミット群 | `gitleaks git --log-opts=<range>` |

gh の PR/Issue/コメント本文は git フックでは守れないため、Claude 経由の送信は
`../hooks/scan-gh-body.sh`（`.claude/settings.json` の PreToolUse hook）で別途スキャンする。

## 社内固有語 / PII の denylist

`deny-terms.local.txt`（**ローカル専用・.gitignore 済み**）に 1 行 1 正規表現で列挙すると、
各フックが staged 追加行・コミットメッセージ・gh 本文を grep する。
denylist 自体が社内情報なのでコミットしない。

## 誤検知の逃がし

- 該当行に `gitleaks:allow` コメント
- `.gitleaksignore` に指紋を登録
- `.gitleaks.toml` の `[allowlist].paths` に除外パスを追加

## 最後の砦（GitHub 側）

ローカルフックをすり抜けても止まるよう、GitHub の
**Secret scanning → Push protection** をリポジトリ設定で有効化する。
