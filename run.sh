#!/usr/bin/env bash
set -euo pipefail

PORT="${CLAUDE_UI_PORT:-3111}"
ASTRO_PORT="${ASTRO_PORT:-4321}"
DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$BRIDGE_PID" "$ASTRO_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" "$ASTRO_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Start bridge server
echo "Starting bridge server on port $PORT..."
cd "$DIR"
CLAUDE_UI_PORT="$PORT" bun server/index.ts 2>&1 &
BRIDGE_PID=$!
sleep 1

# Start astro dev server
echo "Starting Astro dev server on port $ASTRO_PORT..."
PUBLIC_CLAUDE_SERVER_URL="http://localhost:$PORT" \
PUBLIC_CLAUDE_CWD="$(pwd)" \
bun run dev --port "$ASTRO_PORT" &
ASTRO_PID=$!

echo ""
echo "==========================================="
echo "  Claude Code UI:    http://localhost:$ASTRO_PORT"
echo "  Bridge Server:     http://localhost:$PORT"
echo "==========================================="
echo ""

wait
