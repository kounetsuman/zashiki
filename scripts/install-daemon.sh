#!/usr/bin/env bash
#
# zashiki daemon（launchd LaunchAgent）インストール（macOS / identifier: io.github.kounetsuman.zashiki）
#
# 決定（#11/#238）: KeepAlive あり / RunAtLoad なし（アプリ起動時に遅延起動）。
# plist の正本は Rust の launchd.rs。ここでは `zashiki-server print-plist` を呼んで生成する。
#
# 使い方:
#   bash scripts/install-daemon.sh                 # 開発ツリーの cargo 出力を使う
#   ZK_SERVER_BIN=/path/to/zashiki-server \
#     bash scripts/install-daemon.sh               # バイナリを明示
#
set -euo pipefail

APP_ID="io.github.kounetsuman.zashiki"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${APP_ID}.plist"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# server バイナリを解決（ZK_SERVER_BIN > 再ビルドした release > 既存 release > debug）。
# 明示指定が無い限り、常駐デーモンに古いバイナリを登録しないよう release を再ビルドして鮮度を担保する。
# 古い常駐サーバーは新しいクライアントの新規メッセージ（例: config.update）を弾き
# 「invalid_message: invalid client message」を返す版ずれ事故を起こす（#364）。
if [[ -n "${ZK_SERVER_BIN:-}" ]]; then
  BIN="${ZK_SERVER_BIN}"
else
  RELEASE="${REPO_ROOT}/crates/zashiki-server/target/release/zashiki-server"
  DEBUG="${REPO_ROOT}/crates/zashiki-server/target/debug/zashiki-server"
  SERVER_MANIFEST="${REPO_ROOT}/crates/zashiki-server/Cargo.toml"
  if command -v cargo >/dev/null 2>&1; then
    echo "zashiki-server を release ビルドします（デーモン登録前の鮮度担保）。"
    cargo build --release --manifest-path "$SERVER_MANIFEST"
    BIN="$RELEASE"
  elif [[ -x "$RELEASE" ]]; then
    echo "警告: cargo が無いため既存の release バイナリを使用します（古い可能性あり）。" >&2
    BIN="$RELEASE"
  elif [[ -x "$DEBUG" ]]; then
    echo "警告: cargo が無いため既存の debug バイナリを使用します（古い可能性あり）。" >&2
    BIN="$DEBUG"
  else
    echo "エラー: zashiki-server バイナリが見つかりません。" >&2
    echo "  cargo build --release --manifest-path crates/zashiki-server/Cargo.toml を実行するか ZK_SERVER_BIN を指定してください。" >&2
    exit 1
  fi
fi

echo "server バイナリ: ${BIN}"
mkdir -p "${PLIST_DIR}" "${HOME}/Library/Logs"

# plist を Rust 側（正本）から生成する。
ZK_SERVER_BIN="${BIN}" "${BIN}" print-plist >"${PLIST_PATH}"
echo "plist を書き出しました: ${PLIST_PATH}"

# 既存ロードがあれば外してから読み直す（冪等）。
if launchctl list "${APP_ID}" >/dev/null 2>&1; then
  echo "既存の LaunchAgent を unload します。"
  launchctl unload "${PLIST_PATH}" 2>/dev/null || true
fi
launchctl load "${PLIST_PATH}"
echo "LaunchAgent を load しました（RunAtLoad なし = 起動はアプリ/手動）。"
echo
echo "今すぐ起動するには:  launchctl start ${APP_ID}"
echo "状態確認:            launchctl list ${APP_ID}"
echo "停止:                launchctl stop ${APP_ID}"
