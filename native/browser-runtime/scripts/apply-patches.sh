#!/usr/bin/env bash
set -euo pipefail

# Usage: apply-patches.sh <chromium-src> <electron-src> [--check-only]
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$HERE/apply-patches.py" "$@"
