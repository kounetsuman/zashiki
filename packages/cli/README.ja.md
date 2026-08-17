[English](https://github.com/kounetsuman/zashiki/blob/main/packages/cli/README.md) | **日本語**

# @zashiki/cli（CLI / npm 公開パッケージ）

`npm install -g @zashiki/cli` で入る CLI 本体。`zashiki` コマンドで Rust server（`zashiki-server`）を
起動し、同梱した client dist を配信させて、ブラウザで開く。（ネイティブ窓が好みなら、同じコックピットを
デスクトップアプリ版としても配布している — `Zashiki.dmg` リリースを参照。）

```sh
npm install -g @zashiki/cli
zashiki                 # server 起動 → ブラウザで http://127.0.0.1:8790/?token=... を開く
zashiki --port 9000     # ポート変更（既定 8790 / 環境変数 ZK_PORT）
zashiki --no-open       # ブラウザを開かず URL を表示するだけ
```

## 構成

- `bin/zashiki.mjs` … エントリ。`src/launcher.mjs` の `run()` を呼ぶ。
- `src/launcher.mjs` … 起動オーケストレーション（spawn / adopt / healthz 待ち / open）。正本は
  `apps/desktop/src-tauri/src/sidecar.rs`（Tauri シェルの起動シーケンス）を Node へ移植したもの。
- `src/lib.mjs` … 純関数（引数解釈・ポート/トークン検証・URL 組み立て・健全性判定）。仕様は
  `src/lib.test.mjs` が正本。
- `client-dist/` … `@zashiki/client` のビルド成果物を `build`（`scripts/copy-client-dist.mjs`）で同梱。
  server の `ZK_CLIENT_DIST` として静的配信される。**pack tarball に含まれること**が白画面回避の生命線。

## server バイナリの配布

`zashiki-server` は `optionalDependencies` のプラットフォーム別パッケージ
（`@zashiki/server-darwin-arm64` / `-x64`）として配り、`npm` が実行環境に合うものだけ入れる。
CLI は `require.resolve('@zashiki/server-<os>-<arch>/bin/zashiki-server')` で解決する
（`ZK_SERVER_BIN` があれば最優先）。

## 起動シーケンス（launcher）

1. 実効ポート決定（`--port` > `ZK_PORT` > 8790）。
2. 既に `/healthz` が OK なら既存 server を **adopt**（spawn せず・終了時 shutdown もしない）。
   その際 `/` が HTML を返すこと（client UI 配信）と token-probe 受理を確認する。
3. 未起動なら `ZK_CLIENT_DIST=同梱 dist` と自前生成の `ZK_TOKEN` を渡して spawn。
4. `/healthz` をポーリングで待ち、`http://127.0.0.1:PORT/?token=TOKEN` をブラウザで開く。
5. `SIGINT`/`SIGTERM` を子のプロセスグループへ転送して graceful shutdown する。

## ローカル疎通確認

リポジトリルートで:

```sh
pnpm verify:npm-pack
```

client ビルド → dist 同梱 → host バイナリ生成 → `pnpm pack` → tarball 展開 → 実 CLI 起動 →
`/healthz`・token-probe・`/`（HTML 配信）を隔離環境で検証する。

> 実 npm publish と release CI（プラットフォーム別バイナリのタグビルド・x64 充填）は後続 issue。
> ローカル疎通はホスト（arm64）パッケージのみで完結する。
