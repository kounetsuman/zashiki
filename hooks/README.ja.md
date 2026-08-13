[English](./README.md) | **日本語**

# hooks/ — Claude Code hook 合流点

`notify-event.sh` は Claude Code の hook（UserPromptSubmit / PostToolUse / Notification / Stop）から呼ばれ、zashiki サーバの `POST /api/hooks/event` へイベントを転送する薄いシェル。サーバはこれを受けて状態の即時再評価と通知配送を行う。

## 設計上の約束

- **サーバ停止中でも Claude Code をブロック・失敗させない**（`curl --max-time 1 … || true`、常に exit 0）。
- トークンは `~/.zashiki/token`（サーバ起動時に 0600 で生成）を読む。無ければ POST を黙ってスキップ。
- **置換でなく合流**: `ZK_LEGACY_NOTIFY` に既存 cw 側スクリプトを指定すると、POST の後に stdin をそのまま渡して呼ぶ（既存の通知経路を殺さない）。

## セットアップ

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

## 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `ZK_PORT` | `8790` | POST 先サーバのポート |
| `ZK_TOKEN_FILE` | `~/.zashiki/token` | トークンファイル（テスト用の差し替え口） |
| `ZK_LEGACY_NOTIFY` | （空） | 合流先の既存通知スクリプト（実行可能ファイルのみ） |
