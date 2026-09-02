#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree must be clean" >&2
  exit 1
fi
if ! git rev-parse "$TAG^{commit}" >/dev/null 2>&1; then
  echo "error: local tag $TAG does not exist" >&2
  exit 1
fi
if [[ "$(git rev-parse "$TAG^{commit}")" != "$(git rev-parse HEAD)" ]]; then
  echo "error: $TAG does not point to HEAD" >&2
  exit 1
fi

REMOTE_TAG=$(git ls-remote origin "refs/tags/$TAG" | awk '{print $1}')
if [[ -z "$REMOTE_TAG" || "$REMOTE_TAG" != "$(git rev-parse "$TAG^{commit}")" ]]; then
  echo "error: push $TAG to origin before finalizing the release" >&2
  exit 1
fi

RELEASE_ID=$(gh api "repos/{owner}/{repo}/releases" \
  --jq "map(select(.tag_name == \"$TAG\" and .draft == true))[0].id // empty")
if [[ -z "$RELEASE_ID" ]]; then
  PUBLISHED=$(gh api "repos/{owner}/{repo}/releases/tags/$TAG" --jq '.draft == false' 2>/dev/null || true)
  if [[ "$PUBLISHED" == "true" ]]; then
    echo "error: $TAG is already published" >&2
  else
    echo "error: no draft release found for $TAG; run npm run release:publish first" >&2
  fi
  exit 1
fi

EXPECTED_ASSETS=$'SHA256SUMS\nStacks-arm64.zip\nStacks.app.tar.gz\nStacks.app.tar.gz.sig\nlatest.json'
ACTUAL_ASSETS=$(gh api "repos/{owner}/{repo}/releases/$RELEASE_ID" --jq '.assets | map(.name) | sort | .[]')
if [[ "$ACTUAL_ASSETS" != "$EXPECTED_ASSETS" ]]; then
  echo "error: draft release assets do not match the expected set" >&2
  exit 1
fi

PUBLISHED_URL=$(gh api --method PATCH "repos/{owner}/{repo}/releases/$RELEASE_ID" \
  -F draft=false -f make_latest=true --jq '.html_url')

LATEST_TAG=$(gh api "repos/{owner}/{repo}/releases/latest" --jq '.tag_name')
if [[ "$LATEST_TAG" != "$TAG" ]]; then
  echo "error: published $TAG, but GitHub reports $LATEST_TAG as latest" >&2
  exit 1
fi

echo "Published $TAG as the latest release."
echo "$PUBLISHED_URL"
