#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
NOTES="releases/$TAG.md"
OUT="release-artifacts/$TAG"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree must be clean" >&2
  exit 1
fi
if [[ ! -f "$OUT/Stacks-arm64.zip" || ! -f "$OUT/latest.json" ]]; then
  echo "error: run npm run release:prepare first" >&2
  exit 1
fi
if ! git rev-parse "$TAG^{commit}" >/dev/null 2>&1; then
  echo "error: create and push tag $TAG before publishing" >&2
  exit 1
fi
if [[ "$(git rev-parse "$TAG^{commit}")" != "$(git rev-parse HEAD)" ]]; then
  echo "error: $TAG does not point to HEAD" >&2
  exit 1
fi

gh release create "$TAG" "$OUT/Stacks-arm64.zip" \
  --draft --title "Stacks $TAG" --notes-file "$NOTES"
gh release upload "$TAG" \
  "$OUT/Stacks.app.tar.gz" \
  "$OUT/Stacks.app.tar.gz.sig" \
  "$OUT/latest.json" \
  "$OUT/SHA256SUMS"

FIRST_ASSET=$(gh api "repos/{owner}/{repo}/releases/tags/$TAG" --jq '.assets[0].name')
if [[ "$FIRST_ASSET" != "Stacks-arm64.zip" ]]; then
  echo "error: legacy updater ZIP is not the first release asset" >&2
  exit 1
fi

echo "Draft release created. Smoke-test it, then publish it in GitHub."
