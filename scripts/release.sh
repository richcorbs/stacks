#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
NOTES="releases/$TAG.md"
OUT="release-artifacts/$TAG"
BUNDLE_DIR="src-tauri/target/release/bundle/macos"

if [[ ! -f "$NOTES" ]]; then
  echo "error: missing release notes: $NOTES" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: commit or stash changes before preparing a release" >&2
  exit 1
fi

npm run check:version
npm run test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run release:build

rm -rf "$OUT"
mkdir -p "$OUT"
ditto -c -k --keepParent "$BUNDLE_DIR/Stacks.app" "$OUT/Stacks-arm64.zip"
cp "$BUNDLE_DIR/Stacks.app.tar.gz" "$OUT/"
cp "$BUNDLE_DIR/Stacks.app.tar.gz.sig" "$OUT/"
node scripts/create-update-manifest.mjs \
  "$OUT/Stacks.app.tar.gz" \
  "$OUT/Stacks.app.tar.gz.sig" \
  "$OUT/latest.json"

shasum -a 256 "$OUT"/* > "$OUT/SHA256SUMS"
echo "Prepared free, locally built release assets in $OUT"
