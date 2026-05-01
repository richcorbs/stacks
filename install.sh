#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Stacks Tauri.app"
BUILT_APP="$ROOT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME"
DEST_DIR="${DEST_DIR:-$HOME/Applications}"

if [[ "${1:-}" == "--system" ]]; then
  DEST_DIR="/Applications"
elif [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<USAGE
Usage: ./install.sh [--system]

Copies the built macOS app to a dogfooding location.

Default:   ~/Applications/Stacks Tauri.app
--system:  /Applications/Stacks Tauri.app  may prompt for sudo

Set DEST_DIR=/some/path to override the destination directory.
If the app has not been built yet, this script runs: npm run tauri build
USAGE
  exit 0
fi

if [[ ! -d "$BUILT_APP" ]]; then
  echo "Built app not found. Building release app first..."
  source "$HOME/.cargo/env" 2>/dev/null || true
  (cd "$ROOT_DIR" && npm run tauri build)
fi

if [[ ! -d "$BUILT_APP" ]]; then
  echo "error: Built app still not found at: $BUILT_APP" >&2
  exit 1
fi

mkdir -p "$DEST_DIR" 2>/dev/null || true
DEST_APP="$DEST_DIR/$APP_NAME"

copy_app() {
  rm -rf "$DEST_APP"
  ditto "$BUILT_APP" "$DEST_APP"
}

if [[ ! -w "$DEST_DIR" ]]; then
  echo "Installing to $DEST_DIR requires elevated permissions."
  sudo mkdir -p "$DEST_DIR"
  sudo rm -rf "$DEST_APP"
  sudo ditto "$BUILT_APP" "$DEST_APP"
  sudo xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true
else
  copy_app
  xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true
fi

echo "Installed: $DEST_APP"
echo "Open it with: open '$DEST_APP'"
