#!/usr/bin/env bash
# 配布物として完結する Zashiki.app を一気通貫でビルドする（issue #315）。
#
#   client dist ビルド → server release ビルド → sidecar 同梱物を src-tauri へ配置
#   （server は externalBin 命名規則の binaries/zashiki-server-<target-triple>、
#    client dist は resources の client-dist/）→ tauri build。
#
# ルート `pnpm build` には連結しない（CI 負荷回避）。専用コマンドとして叩く:
#   pnpm -F @zashiki/desktop build:app
set -euo pipefail

# --prepare-only: 同梱物の配置までで止め、tauri build は呼び手（CI の tauri-action 等）に委ねる。
prepare_only=false
if [ "${1:-}" = "--prepare-only" ]; then
  prepare_only=true
  shift
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tauri_dir="apps/desktop/src-tauri"
server_manifest="crates/zashiki-server/Cargo.toml"
# ホストターゲット前提（クロスコンパイル・.cargo/config.toml の build.target 上書きは非対応）。
# cargo build も --target 未指定なので、cp 元 target/release と triple 名はホストで一致する。
target_triple="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$target_triple" ]; then
  echo "error: rustc のホストターゲットトリプルを取得できませんでした" >&2
  exit 1
fi

echo "==> shared / client をビルド（client は origin 相対で配信されるため VITE_ZK_SERVER は付けない）"
pnpm --filter @zashiki/shared build
pnpm --filter @zashiki/client build

echo "==> zashiki-server を release ビルド"
cargo build --release --manifest-path "$server_manifest"

echo "==> sidecar 同梱物を $tauri_dir へ配置"
# externalBin は binaries/zashiki-server-<target-triple> を要求し、.app では Contents/MacOS/zashiki-server になる
# （sidecar.rs の兄弟探索と一致）。過去 triple の残骸を同梱しないよう毎回作り直す。
rm -rf "$tauri_dir/binaries"
mkdir -p "$tauri_dir/binaries"
cp "crates/zashiki-server/target/release/zashiki-server" \
  "$tauri_dir/binaries/zashiki-server-$target_triple"

# client dist は resources 経由で Contents/Resources/client-dist へ入る（sidecar.rs の bundled_client_dist と一致）。
rm -rf "$tauri_dir/client-dist"
cp -R "packages/client/dist" "$tauri_dir/client-dist"

if [ "$prepare_only" = true ]; then
  echo "==> --prepare-only: 同梱物の配置まで完了（tauri build はスキップ）"
  exit 0
fi

echo "==> tauri build"
# externalBin / resources は同梱専用（tauri.bundle.conf.json）。dev / build:shell を
# 未ステージの binaries で落とさないよう、build:app のときだけ --config でマージする。
pnpm --filter @zashiki/desktop exec tauri build --config "$repo_root/$tauri_dir/tauri.bundle.conf.json" "$@"

echo "==> 完了: $tauri_dir/target/release/bundle/macos/Zashiki.app"
