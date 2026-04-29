#!/bin/bash
# Build the Tauri sidecar payload: a copy of the host's `bun` binary plus a
# bundled `server.js`. Emitted into `src-tauri/sidecar/` and consumed by
# `tauri.conf.json` (`bundle.externalBin` + `bundle.resources`).
#
# Tauri's `externalBin` mechanism requires the binary be suffixed with the
# host target triple (e.g. `bun-aarch64-apple-darwin`) so cross-compiled
# bundles pick the right one. We detect the triple via `rustc -vV`.
#
# Re-run any time the bundled bun version, server source, or target host
# changes. Idempotent.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SIDECAR_DIR="$PROJECT_DIR/src-tauri/sidecar"

mkdir -p "$SIDECAR_DIR"

BUN_PATH=$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
if [ ! -x "$BUN_PATH" ]; then
    echo "Error: bun not found at $BUN_PATH" >&2
    echo "Install with: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

if ! command -v rustc >/dev/null 2>&1; then
    echo "Error: rustc not found — needed to detect the host target triple." >&2
    echo "Install via https://rustup.rs/" >&2
    exit 1
fi

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$TRIPLE" ]; then
    echo "Error: failed to detect host target triple from rustc -vV" >&2
    exit 1
fi

EXT=""
case "$TRIPLE" in
    *windows*) EXT=".exe" ;;
esac

BUN_OUT="$SIDECAR_DIR/bun-$TRIPLE$EXT"
SERVER_OUT="$SIDECAR_DIR/server.js"

echo "-- Copying bun ($BUN_PATH) -> $BUN_OUT"
cp "$BUN_PATH" "$BUN_OUT"
chmod +x "$BUN_OUT"

echo "-- Bundling server -> $SERVER_OUT"
cd "$PROJECT_DIR"
"$BUN_PATH" build ./server/index.ts \
    --outfile "$SERVER_OUT" \
    --target bun \
    --minify >/dev/null

# Drop legacy node-pty helper from older builds.
rm -f "$SIDECAR_DIR/pty-helper.mjs"
rm -rf "$SIDECAR_DIR/node_modules/node-pty"

echo "-- Done"
ls -lh "$BUN_OUT" "$SERVER_OUT"
