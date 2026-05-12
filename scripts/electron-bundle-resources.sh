#!/usr/bin/env bash
# Bundle the Electron extraResources: the bun runtime + server.js, into
# `electron/resources/`. Consumed by electron-builder via the package.json
# `build.extraResources` array. Idempotent — re-run any time the bundled
# bun version or server source changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$PROJECT_DIR/electron/resources"

mkdir -p "$OUT_DIR"

BUN_PATH=$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
if [ ! -x "$BUN_PATH" ]; then
  echo "Error: bun not found at $BUN_PATH" >&2
  echo "Install with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin*|Linux*) BUN_OUT="$OUT_DIR/bun" ;;
  MINGW*|MSYS*|CYGWIN*) BUN_OUT="$OUT_DIR/bun.exe" ;;
  *) BUN_OUT="$OUT_DIR/bun" ;;
esac

echo "-- Copying bun ($BUN_PATH) -> $BUN_OUT"
cp "$BUN_PATH" "$BUN_OUT"
chmod +x "$BUN_OUT"

SERVER_OUT="$OUT_DIR/server.js"
echo "-- Bundling server -> $SERVER_OUT"
cd "$PROJECT_DIR"
"$BUN_PATH" build ./server/index.ts \
  --outfile "$SERVER_OUT" \
  --target bun \
  --minify >/dev/null

echo "-- Done"
ls -lh "$BUN_OUT" "$SERVER_OUT"
