[English](./README.md) | **日本語**

# e2e

ブラウザモードの E2E テスト（Playwright）。UI はブラウザで検証する
（Tauri シェル自体はスモーク + 手動）。

## 構成

- `harness/boot.mjs` — `createZashikiServer` を**固定トークン**でプログラム起動するサーバハーネス。
  Playwright の `webServer` から起動する。実 ps / 実 `~/.claude/projects` / 実セッションに触れず、
  フィクスチャ組織で決定的に待ち受ける。
- `harness/constants.ts` — ポート・固定トークン・フィクスチャ組織（ハーネスとテストで共有）。
- `harness/app.ts` — `gotoApp(page)` などの入口ヘルパ（`?token=` 付きで開き、シェル描画を待つ）。
- `tests/*.spec.ts` — 機能ドメインごとの spec。1 describe = 1 ユーザーストーリー、
  1 test = 1 受け入れ基準（ケース名がそのまま仕様の目次になる粒度）。

## 実行

client / server の dist が必要なので、初回・変更後はビルドしてから実行する。

```sh
pnpm build                 # リポジトリルートで（client dist / server dist を生成）
pnpm -F @zashiki/e2e exec playwright install chromium   # 初回のみ（ブラウザ取得）
pnpm e2e                   # ルートから e2e を実行（= playwright test）
```

`pnpm e2e` は `webServer`（`node harness/boot.mjs`）を自動起動・自動停止する。
ローカルでは `reuseExistingServer` により既存サーバを再利用する。

## スコープ（現状）

- 実装済みは**正常系のみ**（アプリシェル起動・ビュー切替・セッション一覧の見出し）。
- 実 PTY + fake claude を要する session-lifecycle / terminal-io、異常系・境界は後続 issue。
- IME 合成・端末のスクロールバック/コピーは Playwright で忠実再現できないためスコープ外。
