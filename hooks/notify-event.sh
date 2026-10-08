#!/bin/bash
# Claude Code hook → zashiki サーバへの薄い合流点（詳細は hooks/README.md）。
#
# 使い方（~/.claude/settings.json の hooks から。詳細は hooks/README.md）:
#   notify-event.sh <kind>
#   kind: prompt|tool|waiting|done|subagent_end（Claude Code の hook 名
#         UserPromptSubmit|PostToolUse|Notification|Stop|SubagentStop でも可）
#
# 鉄則: サーバ停止中でも Claude Code を絶対にブロック・失敗させない。
# - curl は --max-time 1 + `|| true`（接続不可は即失敗して抜ける）
# - トークン（~/.zashiki/token）が無ければ POST を黙ってスキップ
# - ZK_LEGACY_NOTIFY があれば既存 cw 側スクリプトを続けて呼ぶ（置換でなく合流）
set -u

kind="${1:-}"
input="$(cat 2>/dev/null || true)"

# 既存 cw 側通知スクリプト（notify-waiting.sh / stop-notify.sh 等）への合流。
# hook ごとに ZK_LEGACY_NOTIFY=<script> を hook コマンドの環境として与える。
run_legacy() {
  if [ -n "${ZK_LEGACY_NOTIFY:-}" ] && [ -x "${ZK_LEGACY_NOTIFY}" ]; then
    printf '%s' "$input" | "$ZK_LEGACY_NOTIFY" >/dev/null 2>&1 || true
  fi
}

# Claude Code の hook 名 → サーバの kind へ写像（未知の kind は POST せず終了）
case "$kind" in
  UserPromptSubmit | prompt) kind=prompt ;;
  PostToolUse | tool) kind=tool ;;
  Notification | waiting)
    kind=waiting
    # notification_type gates waiting (see hooks/README.md); "" also covers older Claude Code / no jq.
    if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
      ntype="$(printf '%s' "$input" | jq -r '.notification_type // ""' 2>/dev/null || true)"
      case "$ntype" in
        "" | permission_prompt | elicitation_dialog) ;;
        *)
          run_legacy
          exit 0
          ;;
      esac
    fi
    ;;
  Stop | done) kind=done ;;
  SubagentStop | subagent_end) kind=subagent_end ;;
  *)
    run_legacy
    exit 0
    ;;
esac

sid=""
cwd=""
agent_id=""
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  sid="$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || true)"
  cwd="$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || true)"
  # SubagentStop の session_id は親セッションのもの。終わったエージェント自身は agent_id で判る。
  agent_id="$(printf '%s' "$input" | jq -r '.agent_id // ""' 2>/dev/null || true)"
fi

# set -u 下でも HOME 未設定（最小環境）で死なない（その場合は POST スキップ）
token_file="${ZK_TOKEN_FILE:-${HOME:-}/.zashiki/token}"
if [ -r "$token_file" ]; then
  token="$(cat "$token_file" 2>/dev/null || true)"
  if [ -n "$token" ]; then
    if command -v jq >/dev/null 2>&1; then
      # ZK_COCKPIT_TERMINAL_ID は zashiki が claude 起動時に渡し、hook へ継承される（どのターミナルの claude か）
      body="$(jq -cn --arg kind "$kind" --arg sid "$sid" --arg cwd "$cwd" --arg agent "$agent_id" \
        --arg terminal "${ZK_COCKPIT_TERMINAL_ID:-}" \
        '{kind: $kind}
         + (if $sid != "" then {sid: $sid} else {} end)
         + (if $cwd != "" then {cwd: $cwd} else {} end)
         + (if $agent != "" then {agent_id: $agent} else {} end)
         + (if $terminal != "" then {cockpit_terminal_id: $terminal} else {} end)' 2>/dev/null)" ||
      body="{\"kind\":\"$kind\"}"
    else
      # jq 不在時は sid/cwd を諦めて kind だけ送る（値のエスケープ問題を避ける）
      body="{\"kind\":\"$kind\"}"
    fi
    # トークンは引数でなく stdin（-H @-）で渡す（ps の引数一覧に晒さない）
    printf 'x-zashiki-token: %s' "$token" |
      curl --max-time 1 -s -o /dev/null -X POST \
        -H @- \
        -H "content-type: application/json" \
        --data "$body" \
        "http://127.0.0.1:${ZK_PORT:-8790}/api/hooks/event" || true
  fi
fi

run_legacy
exit 0
