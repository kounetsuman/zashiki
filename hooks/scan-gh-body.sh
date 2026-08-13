#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) hook。
# gh の PR/Issue/コメント本文（git 管理外＝git hook では守れない盲点）を送信前に走査し、
# 秘密情報/社内固有語/PII を検知したら deny する。zashiki の .claude/settings.json から登録。
set -euo pipefail

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -z "$CMD" ] && exit 0

# 本文を送る gh コマンドのみ対象（GH_CONFIG_DIR=... の前置きがあっても部分一致でヒット）
echo "$CMD" | grep -Eq 'gh[[:space:]]+(pr|issue|release)[[:space:]]+(create|comment|edit)|gh[[:space:]]+api[[:space:]]' || exit 0
command -v gitleaks >/dev/null 2>&1 || exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
DENY="$ROOT/.githooks/deny-terms.local.txt"
reason=""

# --body-file / --notes-file / -F / --field が指すファイルパスを抽出
FILES="$(printf '%s\n' "$CMD" | grep -oE -- '(--body-file|--notes-file|-F|--field)[= ][^ ]+' | sed -E 's/^[^ =]+[= ]//' | tr -d '"'"'"'' || true)"

# 1. コマンド文字列自体（インライン --body "..." を含む）
if ! printf '%s' "$CMD" | gitleaks stdin --no-banner --redact -l error >/dev/null 2>&1; then
  reason="gh コマンド内に秘密情報の疑い"
fi

# 2. 本文ファイルの中身
for f in $FILES; do
  [ -f "$f" ] || continue
  if ! gitleaks stdin --no-banner --redact -l error < "$f" >/dev/null 2>&1; then
    reason="本文ファイル $f に秘密情報の疑い"
  fi
done

# 3. 社内固有語/PII denylist（ローカル専用・任意）
if [ -s "$DENY" ]; then
  PAT="$(grep -vE '^[[:space:]]*(#|$)' "$DENY" || true)"
  if [ -n "$PAT" ]; then
    TXT="$CMD"
    for f in $FILES; do [ -f "$f" ] && TXT="$TXT
$(cat "$f")"; done
    if printf '%s' "$TXT" | grep -nEi -f <(printf '%s\n' "$PAT") >/dev/null 2>&1; then
      reason="社内固有語/PII denylist にヒット"
    fi
  fi
fi

if [ -n "$reason" ]; then
  jq -n --arg r "🚫 gh 送信ブロック: ${reason}。本文/コマンドから秘密情報を除去（露出済みならローテーション）してから再送してください。" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
fi
exit 0
