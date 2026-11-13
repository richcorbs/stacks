#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node parity/run.mjs
node parity/keys.mjs
node parity/selection.mjs
node parity/paste.mjs
