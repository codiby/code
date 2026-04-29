#!/usr/bin/env bash
set -euo pipefail

# Bridge server serves the API, WebSockets, *and* the bundled frontend from
# `dist/`. `bun build --watch` regenerates `dist/` as source files change.
# Browser gets a full page reload on rebuild (Tauri / LAN / Tailscale-Funnel).

PORT="${CLAUDE_UI_PORT:-3111}"
DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$DIR"

# Tauri's `externalBin` declaration requires `src-tauri/sidecar/bun-<triple>`
# to exist at compile time (cargo build copies it next to the binary). Build
# it on first run so a fresh clone can `tauri dev` without an explicit step.
if command -v rustc >/dev/null 2>&1; then
  TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
  if [ -n "$TRIPLE" ] && [ ! -x "$DIR/src-tauri/sidecar/bun-$TRIPLE" ]; then
    bash "$DIR/scripts/bundle-bun.sh"
  fi
fi

# If something is already listening on $PORT, reuse it and exit so Tauri's
# devUrl poll attaches to the existing server instead of double-starting.
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Detected existing server on port $PORT — reusing it."
  exit 0
fi

# Start the frontend watcher in the background.
echo "Starting bun build --watch..."
bun run scripts/build.ts --watch &
BUILD_PID=$!

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$BUILD_PID" 2>/dev/null || true
  wait "$BUILD_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the first build to produce dist/index.html so Tauri's devUrl poll
# (or a browser hitting `/`) doesn't race against an empty dist.
echo "Waiting for first build..."
for _ in $(seq 1 300); do
  [ -f "$DIR/dist/index.html" ] && break
  sleep 0.1
done

echo ""
echo "==========================================="
echo "  Codiby Code:     http://localhost:$PORT"
echo "  Bridge Server:   http://localhost:$PORT"
echo "==========================================="
echo ""

# Replace the shell with the bridge server so Tauri's `beforeDevCommand`
# sees a single, stable PID serving `devUrl`.
exec env CLAUDE_UI_PORT="$PORT" bun server/index.ts
