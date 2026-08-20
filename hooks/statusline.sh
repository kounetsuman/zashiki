#!/bin/bash
# Claude Code statusLine → zashiki サーバへの薄い合流点（詳細は hooks/README.md）。
#
# 使い方（~/.claude/settings.json の statusLine.command に登録）:
#   { "statusLine": { "type": "command", "command": "/path/to/zashiki/hooks/statusline.sh" } }
#
# 目的: statusLine の stdin JSON にだけ載る rate_limits（transcript には無い）をサーバへ渡し、
#       セッションフッタの使用率表示に使う。
#
# 鉄則: サーバ停止中でも Claude Code を絶対にブロック・失敗させない。
# - curl は --max-time 1 + `|| true`（接続不可は即失敗して抜ける）
# - トークン（~/.zashiki/token）が無ければ POST を黙ってスキップ
# - ZK_LEGACY_STATUSLINE があれば既存 statusLine を続けて呼び、その stdout を表示（置換でなく合流）
set -u

input="$(cat 2>/dev/null || true)"

token_file="${ZK_TOKEN_FILE:-${HOME:-}/.zashiki/token}"
if [ -n "$input" ] && [ -r "$token_file" ]; then
  token="$(cat "$token_file" 2>/dev/null || true)"
  if [ -n "$token" ]; then
    printf 'x-zashiki-token: %s' "$token" |
      curl --max-time 1 -s -o /dev/null -X POST \
        -H @- \
        -H "content-type: application/json" \
        --data "$input" \
        "http://127.0.0.1:${ZK_PORT:-8790}/api/hooks/statusline" || true
  fi
fi

# 既存 statusLine への合流（設定時のみ）。その stdout が Claude Code の状態行に出る。
if [ -n "${ZK_LEGACY_STATUSLINE:-}" ] && [ -x "${ZK_LEGACY_STATUSLINE}" ]; then
  printf '%s' "$input" | "$ZK_LEGACY_STATUSLINE" || true
fi
exit 0
