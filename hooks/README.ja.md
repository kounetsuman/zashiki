[English](./README.md) | **日本語**

# hooks/ — Claude Code hook 合流点

`notify-event.sh` は Claude Code の hook（UserPromptSubmit / PostToolUse / Notification / Stop）から呼ばれ、zashiki サーバの `POST /api/hooks/event` へイベントを転送する薄いシェル。サーバはこれを受けて状態の即時再評価と通知配送を行う。

`Notification` を `waiting` として転送するのは、その `notification_type` が画面にウィザード／入力ダイアログを出すもの（`permission_prompt`・`elicitation_dialog`）のときだけ。他の型（`idle_prompt`・`auth_success`・elicitation の完了系）は落とし、アイドルで完了済みのセッションが応答待ちにならないようにする。`notification_type` を持たないペイロード（旧 Claude Code）は従来どおり転送する。

`statusline.sh` は Claude Code の `statusLine` 用の相棒で、そのペイロードを `POST /api/hooks/statusline` へ転送し、セッション状態フッタが使用率を表示できるようにする（`rate_limits` は statusLine コマンドにのみ渡され transcript には載らない）。任意設定であり、フッタのトークン・経過時間は無しでも動く。使用率のセグメントだけがこれを必要とする。

## 設計上の約束

- **サーバ停止中でも Claude Code をブロック・失敗させない**（`curl --max-time 1 … || true`、常に exit 0）。
- トークンは `~/.zashiki/token`（サーバ起動時に 0600 で生成）を読む。無ければ POST を黙ってスキップ。
- **置換でなく合流**: `ZK_LEGACY_NOTIFY` に既存 cw 側スクリプトを指定すると、POST の後に stdin をそのまま渡して呼ぶ（既存の通知経路を殺さない）。

## セットアップ

アプリから自動登録できる。初回起動時にワンクリックのセットアップウィザードを提示し、SETTINGS には
「Claude Code 連携」トグルがある。どちらも `~/.claude/settings.json` へ冪等・可逆にマージし、既存の
hooks/statusLine を保持する（既存 statusLine は `ZK_LEGACY_STATUSLINE` でラップ）。以下の手動登録は
スタンドアロン/上級者向け。

`~/.claude/settings.json` に登録する（パスは各自のリポジトリ位置に読み替え）:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "/path/to/zashiki/hooks/notify-event.sh prompt" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "/path/to/zashiki/hooks/notify-event.sh tool" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "/path/to/zashiki/hooks/notify-event.sh waiting" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/path/to/zashiki/hooks/notify-event.sh done" }] }
    ]
  }
}
```

引数には Claude Code の hook 名（`UserPromptSubmit` 等）をそのまま渡してもよい。

### 既存の通知スクリプトとの併用（合流）

既存の通知スクリプト（notify-waiting.sh / stop-notify.sh 等）を残したまま zashiki にも流す場合は、hook コマンドの環境変数で合流先を指定する:

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "ZK_LEGACY_NOTIFY=/path/to/legacy/notify-waiting.sh /path/to/zashiki/hooks/notify-event.sh waiting" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "ZK_LEGACY_NOTIFY=/path/to/legacy/stop-notify.sh /path/to/zashiki/hooks/notify-event.sh done" }] }
    ]
  }
}
```

二重通知は `ZK_NOTIFY`（サーバ側）とブラウザの通知トグル（client 側）で片方に寄せる。

## セッション状態フッタ（statusLine 橋渡し）

`statusline.sh` を Claude Code の statusLine コマンドとして登録すると、フッタに 5時間・週間の使用率が出る:

```json
{
  "statusLine": { "type": "command", "command": "/path/to/zashiki/hooks/statusline.sh" }
}
```

既存の statusLine も残す場合は `ZK_LEGACY_STATUSLINE` に指定する。POST の後に stdin をそのまま渡して呼び、その stdout が状態行として描画される（置換でなく合流）:

```json
{
  "statusLine": { "type": "command", "command": "ZK_LEGACY_STATUSLINE=/path/to/legacy/statusline.sh /path/to/zashiki/hooks/statusline.sh" }
}
```

## 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `ZK_PORT` | `8790` | POST 先サーバのポート |
| `ZK_TOKEN_FILE` | `~/.zashiki/token` | トークンファイル（テスト用の差し替え口） |
| `ZK_LEGACY_NOTIFY` | （空） | 合流先の既存通知スクリプト（実行可能ファイルのみ） |
| `ZK_LEGACY_STATUSLINE` | （空） | 合流先の既存 statusLine（`sh -c` 経由で実行＝パスも引数付きコマンドも可。stdout が描画される） |
