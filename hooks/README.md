**English** | [日本語](./README.ja.md)

# hooks/ — Claude Code hook confluence point

`notify-event.sh` is a thin shell called from Claude Code hooks (UserPromptSubmit / PostToolUse / Notification / Stop) that forwards events to the zashiki server's `POST /api/hooks/event`. On receiving them, the server immediately re-evaluates state and delivers notifications.

`statusline.sh` is the companion for Claude Code's `statusLine`: it forwards the payload to `POST /api/hooks/statusline` so the session status footer can show account usage limits (`rate_limits` reaches the statusLine command only, never the transcript). It is optional — the footer's tokens and elapsed time work without it; only the usage-limit segments need it.

## Design guarantees

- **Never block or fail Claude Code even while the server is down** (`curl --max-time 1 … || true`, always exit 0).
- Reads the token from `~/.zashiki/token` (generated with 0600 when the server starts). If absent, the POST is silently skipped.
- **Confluence, not replacement**: if you point `ZK_LEGACY_NOTIFY` at an existing cw-side script, it is called with stdin passed through as-is after the POST (so the existing notification path is not killed).

## Setup

Register it in `~/.claude/settings.json` (adjust the path to your own repository location):

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

You may also pass a Claude Code hook name (`UserPromptSubmit`, etc.) directly as the argument.

### Combining with an existing notification script (confluence)

To keep an existing notification script (notify-waiting.sh / stop-notify.sh, etc.) while also routing to zashiki, specify the confluence target via an environment variable in the hook command:

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

To avoid duplicate notifications, consolidate onto one side using `ZK_NOTIFY` (server side) and the browser notification toggle (client side).

## Session status footer (statusLine bridge)

Register `statusline.sh` as Claude Code's statusLine command so the footer can show 5-hour and weekly usage:

```json
{
  "statusLine": { "type": "command", "command": "/path/to/zashiki/hooks/statusline.sh" }
}
```

To keep an existing statusLine as well, point `ZK_LEGACY_STATUSLINE` at it — after the POST, it is run with stdin passed through and its stdout becomes the rendered status line (confluence, not replacement):

```json
{
  "statusLine": { "type": "command", "command": "ZK_LEGACY_STATUSLINE=/path/to/legacy/statusline.sh /path/to/zashiki/hooks/statusline.sh" }
}
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ZK_PORT` | `8790` | Port of the server to POST to |
| `ZK_TOKEN_FILE` | `~/.zashiki/token` | Token file (override hook for testing) |
| `ZK_LEGACY_NOTIFY` | (empty) | Existing notification script to merge into (executable files only) |
| `ZK_LEGACY_STATUSLINE` | (empty) | Existing statusLine to merge into; its stdout is rendered (executable files only) |
