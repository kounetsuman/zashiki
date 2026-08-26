#!/usr/bin/env bash
#
# zashiki installer for macOS (Apple Silicon).
#
# Downloads the latest release .dmg over curl and installs Zashiki.app into
# /Applications. The .dmg is code-signed with a Developer ID certificate and
# notarized (#25), so Gatekeeper accepts it. Downloads made by curl also do NOT
# carry the com.apple.quarantine attribute (the quarantine-free path from #31).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kounetsuman/zashiki/main/scripts/install.sh | bash
#
# Env:
#   ZASHIKI_VERSION       Pin a release tag (e.g. v0.1.1-rc.1). Default: newest published release.
#   ZASHIKI_INSTALL_DIR   Install destination. Default: /Applications
#   ZASHIKI_SELF_UPDATE   Set to 1 when driven by the in-app updater: the app is already being torn
#                         down by the update helper, so skip the interactive quit (relaunch is the
#                         helper's job). The bundle is still swapped atomically and verified either way.
#
set -euo pipefail

REPO="kounetsuman/zashiki"
APP_NAME="Zashiki.app"
INSTALL_DIR="${ZASHIKI_INSTALL_DIR:-/Applications}"
SELF_UPDATE="${ZASHIKI_SELF_UPDATE:-}"

err()  { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

# --- preflight -------------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || err "macOS only (found $(uname -s))."
arch="$(uname -m)"
[[ "$arch" == "arm64" ]] || err "Apple Silicon (arm64) only; found '$arch'. Build from source for other archs."
command -v curl >/dev/null 2>&1    || err "curl is required."
command -v hdiutil >/dev/null 2>&1 || err "hdiutil is required (macOS only)."
command -v ditto >/dev/null 2>&1   || err "ditto is required (macOS only)."
command -v pgrep >/dev/null 2>&1     || err "pgrep is required (macOS only)."
command -v osascript >/dev/null 2>&1 || err "osascript is required (macOS only)."
command -v codesign >/dev/null 2>&1  || err "codesign is required (macOS only)."
command -v spctl >/dev/null 2>&1     || err "spctl is required (macOS only)."

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

# --- verify the signature before we touch the installed bundle --------------
# Release dmgs are Developer ID-signed and notarized (#25). Verify the mounted app
# before swapping so a truncated download or a tampered dmg can never replace a good
# install — critical on the self-update path, where the swap is unattended.
codesign --verify --deep --strict --verbose=2 "$src" >/dev/null 2>&1 \
  || err "signature verification failed for the downloaded app (codesign). Aborting without touching the installed app."
spctl -a -t exec "$src" >/dev/null 2>&1 \
  || err "notarization/Gatekeeper assessment failed for the downloaded app (spctl). Aborting without touching the installed app."

dest="${INSTALL_DIR%/}/${APP_NAME}"
[[ -w "$INSTALL_DIR" ]] || err "no write permission to ${INSTALL_DIR}. Re-run with a writable ZASHIKI_INSTALL_DIR (e.g. ZASHIKI_INSTALL_DIR=\"\$HOME/Applications\") or via sudo."

# --- quit a running instance before swapping the bundle (#66) ---------------
# Swapping the bundle under a running app leaves it serving the old version until
# relaunch. Ask it to quit first, through the app's own guarded-quit path (#65): a
# busy app (live sessions/agents/shells) prompts, and "Cancel" keeps it running.
# Never hard-kill — if it outlives the grace window, abort rather than clobber a
# bundle the user chose to keep open. Detect by real process (pgrep), not AppleScript
# `is running`, which reports a stale "running" app after the process is long gone.
# Skipped under self-update: the update helper has already terminated the app and owns
# the relaunch, so re-quitting here would only race a dead process (or re-prompt).
app_bin="${APP_NAME%.app}"
if [[ -z "$SELF_UPDATE" ]] && pgrep -x "$app_bin" >/dev/null 2>&1; then
  info "Quitting the running Zashiki ..."
  osascript -e "tell application \"$app_bin\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    pgrep -x "$app_bin" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pgrep -x "$app_bin" >/dev/null 2>&1 && err "Zashiki is still running (finishing its quit, or the quit was cancelled while work was in progress). Re-run the installer once it has quit."
fi

# --- swap the bundle via staged renames -------------------------------------
# Copy the new app to a staging path first, then move it into place by rename, keeping
# the previous bundle as a backup until the rename succeeds (and restoring it if the
# rename fails). A failed copy or move therefore never leaves a half-written app: the
# destination is either the new bundle or the untouched previous one.
info "Installing to ${dest} ..."
staging="${dest}.zashiki-new"
backup="${dest}.zashiki-old"
rm -rf "$staging" "$backup"
ditto "$src" "$staging" || { rm -rf "$staging"; err "copy failed."; }
# Belt-and-suspenders: strip quarantine in case the staged copy inherited it.
xattr -dr com.apple.quarantine "$staging" 2>/dev/null || true
if [[ -e "$dest" ]]; then
  mv "$dest" "$backup" || { rm -rf "$staging"; err "could not move the existing app aside."; }
fi
if mv "$staging" "$dest"; then
  rm -rf "$backup"
else
  [[ -e "$backup" ]] && mv "$backup" "$dest"
  err "could not move the new app into place; kept the existing install."
fi

info ""
info "Installed: ${dest}"
[[ -n "$SELF_UPDATE" ]] || info "Launch it from Launchpad / Finder, or run:  open \"$dest\""
