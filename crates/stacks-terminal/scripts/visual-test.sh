#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
UPDATE_VISUAL=${UPDATE_VISUAL:-0} cargo test --test visual_test -- --nocapture
if command -v magick >/dev/null; then
  magick visual-tests/golden.svg visual-tests/golden.png
  echo "wrote visual-tests/golden.png"
fi
