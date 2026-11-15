#!/usr/bin/env bash
# Build the Antigravity egress relay for every bundled platform.
# Requires Go >= 1.27.4 (the go.mod language version pins the transport
# defaults the upstream handshake shape depends on). Stdlib only, no module
# dependencies, CGO disabled so builds are reproducible and cross-compilable
# from any host.
#
# Usage: ./build.sh [output-dir]   (default: ./dist)
#
# Release packaging places the platform binary next to the engine binary as
# "antigravity-egress" (or "antigravity-egress.exe" on Windows); the engine
# discovers it there, or via KLAUS_ANTIGRAVITY_EGRESS=/path/to/binary.
set -euo pipefail
cd "$(dirname "$0")"

OUT="${1:-dist}"
mkdir -p "$OUT"

build() {
  GOOS="$1" GOARCH="$2" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT/$3" .
  echo "built $OUT/$3"
}

build darwin arm64 antigravity-egress-darwin-arm64
build darwin amd64 antigravity-egress-darwin-x64
build windows amd64 antigravity-egress-windows-x64.exe
build linux amd64 antigravity-egress-linux-x64
