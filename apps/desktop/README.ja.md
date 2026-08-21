[English](./README.md) | **日本語**

# @zashiki/desktop

Tauri 2.x のデスクトップシェル。起動時に Rust server（`zashiki-server`）を sidecar として
管理し、`~/.zashiki/token` を読んで WebView の初期 URL に `?token=` で注入する
（client の既存 sessionStorage 機構をそのまま利用。トークン検証は
[`crates/README.md`](../../crates/README.ja.md) を参照）。

## 前提

- Rust stable（`rustup` で導入。`rustc --version` が通ること）
- Node 22 / pnpm（リポジトリ共通）

## 起動（開発）

```sh
pnpm install
pnpm -F @zashiki/desktop dev   # = tauri dev
```

### 隔離サンドボックスインスタンス

```sh
pnpm -F @zashiki/desktop dev:sandbox
```

`dev:sandbox`（`scripts/dev-sandbox.mjs`）は、使い捨ての隔離サンドボックスに対して `tauri dev`
を起動し、8790 で動く本番アプリと並走してクリーンなインスタンスで開発できるようにする。専用の
ポート 8791 で動き、色分けした複数 org と git 初期化済みの repo をいくつか自動生成し、セッションは
**一切 seed せず**（空の SESSION LIST）、real Claude を有効なまま起動するので新規セッションで
Claude が普通に立ち上がる。実ユーザーデータ（`~/.zashiki` / `~/.claude`）には一切触れない
（temp は終了時に削除）。出力される `sandbox-spec.json` を編集し `--config <path>`
（または `ZASHIKI_SANDBOX_CONFIG`）で再実行すると org/repo を変更できる。これは開発専用で、
公開 `zashiki` CLI には**含めない**。

`tauri dev` が `beforeDevCommand` で Rust server の `cargo build` と Vite dev サーバ（:5173、
`VITE_ZK_SERVER=http://127.0.0.1:8790`）を立ち上げ、シェルが以下を行う:

1. ウィンドウを即時表示（内蔵ローディングページ。起動処理はバックグラウンド）
2. `http://127.0.0.1:8790/healthz` で server 稼働確認
3. 未稼働なら `zashiki-server` バイナリを専用プロセスグループで spawn
   （`ZK_PORT` / `ZK_TOKEN_FILE` を渡す。server が起動時に token を生成・書込）
4. `~/.zashiki/token` を読み、実リクエストで受理を確認（古い token の検出。
   検証は `/api/` 配下への 401/403 判定 — `GET /` は静的配信でトークン検証を通らない）
5. 準備できたら WebView を `http://localhost:5173/?token=…` へ遷移

起動に失敗した場合はウィンドウにエラーページ（対処方法つき）を表示し、
詳細はターミナルの stderr（`[zashiki-shell +N.Ns]` の経過ログ）に出る。
setup から Err は返さない（Tauri v2 は setup の Err を内部 panic にするため
`did_finish_launching` 内で unwind できず SIGABRT になる）。

シェル終了時（ウィンドウを閉じる / SIGTERM / Ctrl-C いずれも）、**自分が spawn した
server のみ**プロセスグループへ SIGTERM → 猶予 5s → SIGKILL で落とす（既存 server への
相乗り時は殺さない）。したがって Claude セッションがアプリ終了後も残るのは、ホストする
server が生き続ける場合＝独立した長命 server に相乗りしている時のみで、自分で spawn した
server の場合は一緒に落ちる。

### 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `ZK_PORT` | 8790 | server ポート（healthz / spawn / 本番初期 URL に使用） |
| `ZK_TOKEN_FILE` | `~/.zashiki/token` | トークンファイルの場所（server が生成・書込／sidecar が読む・検証時の隔離用） |
| `ZK_SERVER_BIN` | 実行体と同ディレクトリの `zashiki-server`、無ければ `crates/zashiki-server/target/{release,debug}/zashiki-server` | spawn する Rust server バイナリ |
| `ZK_CLIENT_DIST` | 配布 .app: 実行体から `../Resources/client-dist`（同梱物）／dev: `packages/client/dist` | server に静的配信させる client dist。sidecar は実在するときだけ spawn 時に渡す（dev は Vite:5173 を開くため未生成でも無害） |
| `ZK_SHELL_URL` | dev: `http://localhost:5173` / build: `http://127.0.0.1:8790` | WebView の初期 URL ベース |
| `ZK_CONFIG` | `~/.zashiki/config.json` | server と共有するライブ適用設定ファイル（通知音・更新チェック・表示言語） |
| `ZK_APP_VERSION` | （シェルが注入） | 更新チェック用に server へ渡す実バンドルバージョン（`app.package_info().version`）。server 自身の Cargo バージョンは `0.0.0` プレースホルダのままなので、実バージョンを運ぶのはこの経路だけ。未設定・`0.0.0`（dev）ならチェックは無効 |

## DevTools（WebView インスペクタ）

ウィンドウは常に WebView インスペクタ有効で生成する。設定 → 開発モード →「DevTools を開く」
（`open_devtools` コマンドを呼ぶ）、またはウィンドウを右クリック →「要素の詳細を表示（Inspect Element）」
で開ける（macOS。F12 は WKWebView では既定バインドされない）。

`tauri build` 産でもインスペクタを使えるよう tauri の `devtools` feature を付けている（macOS では
private API を使うため App Store 配布時は非対応。本アプリは App Store 外（Developer ID）配布のため実害はない）。

## 更新チェック（GitHub Releases）

古いバンドルで動かしていると、より新しい **安定版** リリースがあることを NOTIFICATION
パネル（とトースト）で知らせる。`GET https://api.github.com/repos/kounetsuman/zashiki/releases/latest`
を起動時に1回・以降 24 時間ごとにポーリングし（未認証。プレリリースは除外）、最新の安定版タグを
起動中のバンドルバージョンと比較して、新しければ `update-available:<version>` の通知を出す。
オフライン・非 2xx・パース失敗は黙ってスキップし、dev ビルド（バージョン `0.0.0`）はポーリングしない。

既定で有効。github.com への外向き通信を止めたい場合は `~/.zashiki/config.json` の
`updateCheck` を `false` にする:

```json
{ "updateCheck": false }
```

- ライブ適用: フラグはポーリングごとに読むため、再起動なしで切り替わる（`config.sync` で
  クライアントにも配信される）。
- これは通知のみ。自動更新・アプリ内ダウンロードは行わない。
- 仕様の正本は `crates/zashiki-server` の `update_checker` / `notifications` テストと
  `src/config.rs` の `parse_config`（cargo test）。

## ビルド

### 配布ビルド（1つに閉じた .app）

```sh
pnpm -F @zashiki/desktop build:app
```

`build:app`（`scripts/build-app.sh`）が次を一気通貫で行い、`/Applications` に置いて
開発ツリー非依存で動く `Zashiki.app` を作る:

1. `@zashiki/shared` と `@zashiki/client` をビルド（client は同一 origin の server が配信するため
   `VITE_ZK_SERVER` は付けない＝`window.location.origin` 相対で接続する）
2. `zashiki-server` を release ビルド
3. sidecar 同梱物を `src-tauri/` へ配置（生成物なので gitignore 済み）:
   - server → `src-tauri/binaries/zashiki-server-<target-triple>`（`externalBin` 命名規則。
     `.app` では `Contents/MacOS/zashiki-server` になり、sidecar の兄弟探索と一致）
   - client dist → `src-tauri/client-dist/`（`bundle.resources` で `Contents/Resources/client-dist/` へ）
4. `tauri build`（`target/release/bundle/macos/Zashiki.app`）

起動時、sidecar は同梱 `zashiki-server` を spawn し、`ZK_CLIENT_DIST` を
`Contents/Resources/client-dist` へ向ける（server がそれを静的配信し、WebView は
`http://127.0.0.1:8790` を開く）。ルート `pnpm build` には連結しない（CI 負荷回避）。

CI では `vX.Y.Z` tag の push で [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
が同じ `build-app.sh`（`--prepare-only`）で同梱物を配置し、`tauri build`（`--bundles dmg`）本体を
tauri-action に委ねて draft Release へ `Zashiki.dmg` を公開する（macOS のみ）。Apple の secret が
設定されていれば署名 + notarization され、無ければ未署名にフォールバックする——[署名と notarization](#署名と-notarization) 参照。

### 署名と notarization

リリースビルドは、Apple の認証情報が GitHub Actions の secret として揃っているとき
**Developer ID Application 証明書で署名 + notarization** される。この場合 `.app`/`.dmg` は
Gatekeeper の右クリック回避なしで起動する。secret が無いとき（例: fork）はビルドが
**未署名**にフォールバックし、リリース自体は成功する——[`release.yml`](../../.github/workflows/release.yml)
は `APPLE_CERTIFICATE` の有無で署名を出し分ける。

`tauri build` の中で Tauri バンドラが証明書を取り込み、アプリと同梱の `zashiki-server` sidecar を
署名し（hardened runtime は既定で有効）、`notarytool` で notarization し、チケットを staple する。
その後ワークフローが `codesign --verify --deep --strict` と `spctl -a -vvv` で検証する。

初回セットアップ（メンテナ）:

1. [Apple Developer Program](https://developer.apple.com/programs/)（有料）に登録し、
   **Developer ID Application** 証明書を作成する。キーチェーンアクセスから `.p12`（パスワード付き）で
   書き出し、base64 化する: `base64 -i certificate.p12 | pbcopy`。
2. <https://account.apple.com> → サインインとセキュリティ で Apple ID の
   **App 用パスワード**を作成し、Apple Developer アカウントページで 10 文字の
   **Team ID** を控える。
3. 次のリポジトリ secret を追加する（Settings → Secrets and variables → Actions）:

   | Secret | 値 |
   | --- | --- |
   | `APPLE_CERTIFICATE` | 書き出した `.p12` の base64 |
   | `APPLE_CERTIFICATE_PASSWORD` | `.p12` 書き出し時のパスワード |
   | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: NAME (TEAMID)`（`security find-identity -v -p codesigning` で確認） |
   | `APPLE_ID` | notarization に使う Apple ID のメール |
   | `APPLE_PASSWORD` | 手順 2 の App 用パスワード |
   | `APPLE_TEAM_ID` | 10 文字の Team ID |

### Homebrew tap の自動更新

`brew install --cask kounetsuman/tap/zashiki` は
[`kounetsuman/homebrew-tap`](https://github.com/kounetsuman/homebrew-tap) の cask から配信される。
`vX.Y.Z` リリースを publish（`release.yml` の draft を昇格）すると
[`.github/workflows/bump-tap.yml`](../../.github/workflows/bump-tap.yml) が発火し、公開された `.dmg` を
ダウンロードして `sha256` を計算し、`Casks/zashiki.rb` の `version` + `sha256` を書き換えて tap へ push する
（手編集なし）。prerelease では発火しないため、安定版だけが tap に届く。必要な secret は 1 つ:

| Secret | 値 |
| --- | --- |
| `HOMEBREW_TAP_TOKEN` | `kounetsuman/homebrew-tap` に `contents:write` を持つ PAT（ジョブの `GITHUB_TOKEN` はクロスリポジトリに push できない） |

### 開発ツリー依存のシェルビルド

```sh
pnpm -F @zashiki/desktop build:shell            # = tauri build（同梱なし）
pnpm -F @zashiki/desktop tauri build --debug --bundles app   # CI/検証相当
```

> `build:shell` は sidecar 同梱物をステージしないため、生成される `.app` は
> **開発ツリーからの起動を前提**とする（`sidecar.rs` の `default_server_bin` /
> `default_client_dist` がリポジトリ相対の出力にフォールバックするため、`/Applications` へ
> 単体で置いても動かない）。単体で完結させたい場合は `build:app` を使う。

Rust 単体テスト（ヘルスチェック判定・トークン読み・URL 組み立て・同梱物パス解決）:

```sh
pnpm -F @zashiki/desktop test:rust   # = cargo test
```

## 手動スモーク手順（shell smoke は自動化せず手動）

実 server / 実 `~/.zashiki` に触るので人間が実施する。

1. `pnpm build && pnpm -F @zashiki/desktop dev` でシェルを起動する
2. ウィンドウにターミナル UI が表示される（トークン入力を求められないこと =
   トークン注入が効いている）
3. セッション一覧から窓を開き、ターミナルにキー入力が通ることを確認する
4. シェルのウィンドウを閉じて終了する
5. daemon（launchd）運用時は、シェル終了後も `launchctl list io.github.kounetsuman.zashiki` で
   server が生き、`curl -s http://127.0.0.1:8790/healthz` が 200 のまま（claude が死なない）
6. server を先に手で起動（`cargo run --manifest-path crates/zashiki-server/Cargo.toml`）→
   シェル起動 → シェル終了 → `curl -s http://127.0.0.1:8790/healthz` が 200 のまま
   （相乗り時は server を殺さないこと）
7. **配布 .app 完結スモーク**: `pnpm -F @zashiki/desktop build:app` でビルドし、
   `target/release/bundle/macos/Zashiki.app` を `/Applications` へコピーする。
   開発ツリーの外（例: `cd /` してから `open /Applications/Zashiki.app`）で起動し、
   sidecar が同梱 `zashiki-server` を spawn → ウィンドウにターミナル UI が表示される
   （同梱 client dist の静的配信が効いていること）。同梱物の配置は
   `Contents/MacOS/zashiki-server` と `Contents/Resources/client-dist/index.html` で確認できる。

## アンインストール

リポジトリルートから実行する（スクリプト本体は `scripts/uninstall.sh`）:

```sh
pnpm uninstall:app                            # ドライラン（既定・何も消さない）
pnpm uninstall:app -- --yes                   # アプリ・ビルド生成物・~/Library 配下を削除
pnpm uninstall:app -- --yes --purge-user-data # 上記 + ~/.zashiki も削除
```

- **既定はドライラン**。削除対象（`/Applications/Zashiki.app`、`target/release/bundle/`、
  `dist/Zashiki.app`、`~/Library` 配下の `io.github.kounetsuman.zashiki` 関連）を表示するだけで
  何も消さない。実削除には `--yes` が必須。
- **ユーザーデータ `~/.zashiki/`（`repos.conf` / `saves/` / `token`）は
  `--purge-user-data` を付けた時だけ**削除する（既定は保護）。
- launchd daemon（LaunchAgent `io.github.kounetsuman.zashiki`）は `--yes` 時に unload + plist 削除する。

## 既知の制約

- **client dist を配信しない既存 server への相乗り**: 配布 .app は `http://127.0.0.1:8790`
  （server の `/`）を開く。8790 に別の server が既に稼働していると相乗りするが、その server が
  `ZK_CLIENT_DIST` 付きで起動していない（例: `tauri dev` / dist なしの `cargo run`）と `/` を
  配信できない。この場合は**真っ白ではなく対処つきエラーページ**を表示する（`start()` が
  `/` の配信可否を probe し、未配信なら「開発用サーバを終了して起動し直す」旨を返す）。
  対処: 8790 を占有する開発用サーバを終了してから Zashiki.app を起動し直す。配布 .app 同士・
  未起動状態からの起動では自分が spawn する server に client dist を渡すため問題は起きない。
- **`build:shell` 単体では配布不可**: 同梱物をステージしないため、リポジトリ内の cargo 出力
  （`crates/zashiki-server/target/{release,debug}/zashiki-server`）と `packages/client/dist` に
  フォールバックする（開発マシン前提）。単体で完結させるには `build:app` を使う。
- **シェルを kill -9 した場合**、spawn 済み server は孤児として残る（graceful
  shutdown は通常終了・SIGTERM/SIGINT 時のみ）。次回シェル起動時は healthz で検出して
  相乗りするため二重起動にはならない。手で落とす場合は
  `pkill -f 'server/dist/index.js'`。
- **`tauri dev` の既定は `ZK_PORT=8790`**: `beforeDevCommand` がポートからクライアント URL を
  導出するため（`VITE_ZK_SERVER=http://127.0.0.1:${ZK_PORT:-8790}`）、`ZK_PORT` を設定すれば
  server とクライアントが一緒に移動する（`dev:sandbox` が 8790 の本番と並走して 8791 で動く仕組み）。
- GUI 起動しない環境での green 定義は `cargo check` / `cargo test` /
  `tauri build --debug` まで（GUI 実確認は上記手動スモーク）。
