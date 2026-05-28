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

# Copy the per-platform ripgrep binary from @vscode/ripgrep so the packaged
# app ships its own `rg` (the bridge resolves it via CODIBY_RG_PATH).
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) RG_SRC="$PROJECT_DIR/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg" ;;
  Darwin-x86_64) RG_SRC="$PROJECT_DIR/node_modules/@vscode/ripgrep-darwin-x64/bin/rg" ;;
  Linux-x86_64) RG_SRC="$PROJECT_DIR/node_modules/@vscode/ripgrep-linux-x64/bin/rg" ;;
  Linux-aarch64) RG_SRC="$PROJECT_DIR/node_modules/@vscode/ripgrep-linux-arm64/bin/rg" ;;
  MINGW*|MSYS*|CYGWIN*) RG_SRC="$PROJECT_DIR/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe" ;;
  *) RG_SRC="" ;;
esac
if [ -n "$RG_SRC" ] && [ -x "$RG_SRC" ]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) RG_OUT="$OUT_DIR/rg.exe" ;;
    *) RG_OUT="$OUT_DIR/rg" ;;
  esac
  echo "-- Copying rg ($RG_SRC) -> $RG_OUT"
  cp "$RG_SRC" "$RG_OUT"
  chmod +x "$RG_OUT"
else
  echo "-- Skipping rg copy (no @vscode/ripgrep binary for $(uname -s)-$(uname -m))" >&2
fi

echo "-- Done"
ls -lh "$BUN_OUT" "$SERVER_OUT" "$OUT_DIR/rg" 2>/dev/null || true
