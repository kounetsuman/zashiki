#!/usr/bin/env bash
#
# zashiki installer for macOS (Apple Silicon).
#
# Downloads the latest release .dmg over curl and installs Zashiki.app into
# /Applications. Downloads made by curl do NOT carry the com.apple.quarantine
# attribute, so Gatekeeper does not block the (currently unsigned, un-notarized)
# app with the "is damaged and can't be opened" dialog that a browser download
# triggers. Proper signing + notarization is tracked in #25; this installer is
# the quarantine-free path from #31.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kounetsuman/zashiki/main/scripts/install.sh | bash
#
# Env:
#   ZASHIKI_VERSION       Pin a release tag (e.g. v0.1.1-rc.1). Default: newest published release.
#   ZASHIKI_INSTALL_DIR   Install destination. Default: /Applications
#
set -euo pipefail

REPO="kounetsuman/zashiki"
APP_NAME="Zashiki.app"
INSTALL_DIR="${ZASHIKI_INSTALL_DIR:-/Applications}"

err()  { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

# --- preflight -------------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || err "macOS only (found $(uname -s))."
arch="$(uname -m)"
[[ "$arch" == "arm64" ]] || err "Apple Silicon (arm64) only; found '$arch'. Build from source for other archs."
command -v curl >/dev/null 2>&1    || err "curl is required."
command -v hdiutil >/dev/null 2>&1 || err "hdiutil is required (macOS only)."
command -v ditto >/dev/null 2>&1   || err "ditto is required (macOS only)."

# --- resolve the .dmg download URL -----------------------------------------
if [[ -n "${ZASHIKI_VERSION:-}" ]]; then
  ver="${ZASHIKI_VERSION#v}"
  dmg_url="https://github.com/${REPO}/releases/download/${ZASHIKI_VERSION}/Zashiki_${ver}_aarch64.dmg"
else
  info "Resolving the latest release..."
  # per_page=1 restricts parsing to the single newest release so we never silently
  # fall through to an older one when the newest lacks an aarch64 asset. Draft
  # releases are invisible to the unauthenticated API, so this only resolves a
  # published release; pre-releases are allowed until a stable ships.
  # Keep the request separate from the pipeline: under `set -o pipefail` a failed
  # curl (e.g. 403 rate-limit) or a no-match grep inside a `$(...)` assignment
  # would otherwise abort the whole script with no message.
  releases_json="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=1")" \
    || err "GitHub API request failed (rate-limited? set ZASHIKI_VERSION=vX.Y.Z to pin a tag)."
  dmg_url="$(
    printf '%s' "$releases_json" \
      | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*_aarch64\.dmg"' \
      | head -n1 \
      | sed -E 's/.*"(https[^"]*)".*/\1/'
  )" || true
  [[ -n "$dmg_url" ]] || err "the latest release has no *_aarch64.dmg asset yet. Set ZASHIKI_VERSION=vX.Y.Z to pin a tag, or download the dmg from the Releases page."
fi

# --- download (no quarantine, because curl) --------------------------------
tmp="$(mktemp -d "${TMPDIR:-/tmp}/zashiki-install.XXXXXX")"
mnt=""
cleanup() {
  if [[ -n "$mnt" && -d "$mnt" ]]; then
    hdiutil detach "$mnt" -quiet -force >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

dmg="${tmp}/zashiki.dmg"
info "Downloading ${dmg_url##*/} ..."
curl -fL --progress-bar "$dmg_url" -o "$dmg" || err "download failed: $dmg_url"

# --- mount & copy ----------------------------------------------------------
mnt="${tmp}/mnt"
mkdir -p "$mnt"
hdiutil attach "$dmg" -mountpoint "$mnt" -nobrowse -readonly -quiet || err "failed to mount the dmg."

src="${mnt}/${APP_NAME}"
[[ -d "$src" ]] || err "the dmg does not contain ${APP_NAME}."

dest="${INSTALL_DIR%/}/${APP_NAME}"
[[ -w "$INSTALL_DIR" ]] || err "no write permission to ${INSTALL_DIR}. Re-run with a writable ZASHIKI_INSTALL_DIR (e.g. ZASHIKI_INSTALL_DIR=\"\$HOME/Applications\") or via sudo."

info "Installing to ${dest} ..."
rm -rf "$dest"
ditto "$src" "$dest" || err "copy failed."

# Belt-and-suspenders: strip quarantine in case the destination inherited it.
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

info ""
info "Installed: ${dest}"
info "Launch it from Launchpad / Finder, or run:  open \"$dest\""
