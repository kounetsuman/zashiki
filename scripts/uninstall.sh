#!/usr/bin/env bash
#
# zashiki アンインストールスクリプト（macOS / identifier: io.github.kounetsuman.zashiki）
#
# 安全設計:
#   - 既定はドライラン（何を消すかを表示するだけで、一切削除しない）。
#   - 実削除には `--yes` を明示的に付ける必要がある。
#   - ユーザーデータ（~/.zashiki: repos.conf / saves / token）は `--purge-user-data`
#     を明示した時だけ削除する。既定は保護する（誤ってセッション保存を消さないため）。
#   - launchd daemon（LaunchAgent）は --yes 時に unload + plist 削除する。
#
# 使い方:
#   bash scripts/uninstall.sh                          # ドライラン（既定）
#   bash scripts/uninstall.sh --yes                    # アプリ・ビルド生成物・Library を削除
#   bash scripts/uninstall.sh --yes --purge-user-data  # 上記 + ~/.zashiki も削除
#
set -euo pipefail

APP_ID="io.github.kounetsuman.zashiki"
APP_PATH="/Applications/Zashiki.app"

# リポジトリルート（このスクリプトの2つ上）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 多層防御: REPO_ROOT が空 or ルートに解決された場合はビルド生成物の削除に使わない
# （remove_path 側の `[[ -e ]]` ガードと合わせて `rm -rf /apps/...` 等を二重に防ぐ）。
if [[ -z "$REPO_ROOT" || "$REPO_ROOT" == "/" ]]; then
  echo "エラー: リポジトリルートの解決に失敗しました（REPO_ROOT='${REPO_ROOT}'）。中断します。" >&2
  exit 1
fi

DRY_RUN=1
PURGE_USER_DATA=0

usage() {
  cat <<'EOF'
Usage: bash scripts/uninstall.sh [--yes] [--purge-user-data]

  (既定)              ドライラン。削除対象を表示するだけで何も消しません。
  --yes               実際に削除します（アプリ本体・ビルド生成物・~/Library 配下）。
  --purge-user-data   ~/.zashiki（repos.conf / saves / token）も削除します。
                      --yes と併用した時のみ有効。既定では保護されます。
  -h, --help          このヘルプを表示します。
EOF
}

for arg in "$@"; do
  case "$arg" in
    --yes) DRY_RUN=0 ;;
    --purge-user-data) PURGE_USER_DATA=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "不明な引数: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "=== ドライラン（既定） ==="
  echo "実際には何も削除しません。削除するには --yes を付けてください。"
else
  echo "=== 実削除モード（--yes） ==="
fi
echo

# 削除（またはドライラン表示）を行う。存在しないものはスキップする。
remove_path() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  [削除対象] $path"
    else
      echo "  [削除] $path"
      rm -rf -- "$path"
    fi
  else
    echo "  [なし]     $path"
  fi
}

echo "--- 1. アプリ本体 ---"
remove_path "$APP_PATH"
echo

echo "--- 2. ビルド生成物 ---"
remove_path "${REPO_ROOT}/apps/desktop/src-tauri/target/release/bundle"
remove_path "${REPO_ROOT}/dist/Zashiki.app"
echo

echo "--- 3. macOS Library 配下（identifier: ${APP_ID}）---"
# 実在するパスだけを find で拾って対象にする（想定外の場所に残っていても捕捉できる）。
# basename が identifier 完全一致 or `${APP_ID}.<suffix>`（.plist / .savedState 等）
# のものだけに限定する。`*${APP_ID}*` の部分一致だと `com.acme.${APP_ID}-x.plist` や
# `not${APP_ID}` のような別アプリ・無関係ファイルを巻き込むため（誤削除防止）。
library_targets=()
if [[ -d "${HOME}/Library" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && library_targets+=("$line")
  done < <(
    find "${HOME}/Library" -maxdepth 4 \
      \( -iname "${APP_ID}" -o -iname "${APP_ID}.*" \) \
      2>/dev/null || true
  )
fi

if [[ "${#library_targets[@]}" -eq 0 ]]; then
  echo "  [なし]     ~/Library 配下に ${APP_ID} を含むパスは見つかりませんでした。"
else
  for t in "${library_targets[@]}"; do
    remove_path "$t"
  done
fi
echo

echo "--- 4. ユーザーデータ（~/.zashiki）---"
USER_DATA="${HOME}/.zashiki"
if [[ "$PURGE_USER_DATA" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [削除対象] $USER_DATA （--purge-user-data 指定あり。repos.conf / saves / token を含む）"
  else
    remove_path "$USER_DATA"
  fi
else
  if [[ -e "$USER_DATA" ]]; then
    echo "  [保護]     $USER_DATA は保持します（repos.conf / saves / token）。"
    echo "             削除するには --purge-user-data を付けてください。"
  else
    echo "  [なし]     $USER_DATA"
  fi
fi
echo

echo "--- 5. launchd daemon（LaunchAgent: ${APP_ID}）---"
PLIST_PATH="${HOME}/Library/LaunchAgents/${APP_ID}.plist"
LAUNCHD_DOMAIN="gui/$(id -u)"

# LaunchAgent を停止する。新しめの macOS では launchctl load/unload が deprecated で
# no-op になり得るため、まず `bootout gui/<uid> <plist>` を試し、失敗時に旧 unload へ
# フォールバックする。`set -euo pipefail` 下でも非ゼロ終了で全体を殺さないよう、
# 分岐は if 判定で受けて関数は常に 0 で返す（`|| true` の握り潰しは使わない）。
stop_launchd_daemon() {
  if launchctl bootout "${LAUNCHD_DOMAIN}" "$PLIST_PATH" 2>/dev/null; then
    echo "  [停止] launchctl bootout ${LAUNCHD_DOMAIN} ${PLIST_PATH}"
  elif launchctl unload "$PLIST_PATH" 2>/dev/null; then
    echo "  [停止] launchctl unload ${PLIST_PATH}（bootout 不可のためフォールバック）"
  elif launchctl stop "${APP_ID}" 2>/dev/null; then
    echo "  [停止] launchctl stop ${APP_ID}（unload 不可のためフォールバック）"
  else
    echo "  [警告] launchctl での停止に失敗、または既に停止済みでした。"
  fi
  return 0
}

if launchctl list "${APP_ID}" >/dev/null 2>&1 || [[ -e "$PLIST_PATH" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  [停止/削除対象] LaunchAgent ${APP_ID}（launchctl bootout ${LAUNCHD_DOMAIN} → ${PLIST_PATH} 削除）"
  else
    stop_launchd_daemon
    remove_path "$PLIST_PATH"
    # 停止できたかを検証する。list に残っていれば bootout/unload が効いていない。
    if launchctl list "${APP_ID}" >/dev/null 2>&1; then
      echo "  [警告] LaunchAgent ${APP_ID} が launchctl list になお残存しています（停止しきれていない可能性）。" >&2
    else
      echo "  [確認] LaunchAgent ${APP_ID} は launchctl list から消えました（停止済み）。"
    fi
  fi
  echo "  注: daemon が起動していた claude セッションも終了します（必要なら先に save してください）。"
else
  echo "  [なし]     LaunchAgent ${APP_ID} は未登録です。"
fi
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "=== ドライラン完了 ==="
  echo "実削除するには再度 --yes を付けて実行してください。"
else
  echo "=== アンインストール完了 ==="
fi
