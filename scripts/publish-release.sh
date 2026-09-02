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
  --draft --verify-tag --title "Stacks $TAG" --notes-file "$NOTES"
gh release upload "$TAG" \
  "$OUT/Stacks.app.tar.gz" \
  "$OUT/Stacks.app.tar.gz.sig" \
  "$OUT/latest.json" \
  "$OUT/SHA256SUMS"

# GitHub's release-by-tag endpoint returns 404 for drafts, so find the draft
# through the releases collection and verify it by its stable database id.
RELEASE_ID=$(gh api "repos/{owner}/{repo}/releases" \
  --jq "map(select(.tag_name == \"$TAG\" and .draft == true))[0].id // empty")
if [[ -z "$RELEASE_ID" ]]; then
  echo "error: could not find the draft release for $TAG" >&2
  exit 1
fi

EXPECTED_ASSETS=$'SHA256SUMS\nStacks-arm64.zip\nStacks.app.tar.gz\nStacks.app.tar.gz.sig\nlatest.json'
ACTUAL_ASSETS=$(gh api "repos/{owner}/{repo}/releases/$RELEASE_ID" --jq '.assets | map(.name) | sort | .[]')
if [[ "$ACTUAL_ASSETS" != "$EXPECTED_ASSETS" ]]; then
  echo "error: draft release assets do not match the expected set" >&2
  printf 'expected:\n%s\nactual:\n%s\n' "$EXPECTED_ASSETS" "$ACTUAL_ASSETS" >&2
  exit 1
fi

FIRST_UPLOADED=$(gh api "repos/{owner}/{repo}/releases/$RELEASE_ID" --jq '.assets | min_by(.id).name')
if [[ "$FIRST_UPLOADED" != "Stacks-arm64.zip" ]]; then
  echo "error: legacy updater ZIP was not uploaded first" >&2
  exit 1
fi

echo "Draft release created and verified (release id $RELEASE_ID)."
echo "Smoke-test it, then run: npm run release:finalize"
