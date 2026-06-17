#!/usr/bin/env bash
set -euo pipefail

# Bridge server serves the API, WebSockets, *and* the bundled frontend from
# `dist/`. `bun build --watch` regenerates `dist/` as source files change.
# Browser gets a full page reload on rebuild.

DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$DIR"

# Persist stdout+stderr of both the build watcher and the bridge server to
# timestamped log files. A SIGILL ("illegal instruction") is almost always Bun
# panicking; Bun prints its native trace + a bun.report URL to stderr, which
# would otherwise be lost to terminal scrollback. We `tee` so output still
# shows live in the terminal while being captured for post-mortem analysis.
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
BUILD_LOG="$LOG_DIR/build.log"
BRIDGE_LOG="$LOG_DIR/bridge.log"
{
  echo ""
  echo "===== run.sh start $RUN_TS (pid $$) ====="
} | tee -a "$BUILD_LOG" "$BRIDGE_LOG" >/dev/null

load_env_file() {
  local env_file="$1"

  if [ -f "$env_file" ]; then
    set -a
    . "$env_file"
    set +a
  fi
}

load_env_file "$DIR/.env"
load_env_file "$DIR/.env.local"

PORT="${CLAUDE_UI_PORT:-3111}"

resolve_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  if command -v bun.exe >/dev/null 2>&1; then
    command -v bun.exe
    return 0
  fi

  for candidate in \
    "$HOME/.bun/bin/bun" \
    "$HOME/.bun/bin/bun.exe" \
    "/c/Users/${USER:-}/.bun/bin/bun" \
    "/c/Users/${USER:-}/.bun/bin/bun.exe"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

BUN_BIN="$(resolve_bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "Error: bun not found. Install Bun or add it to PATH." >&2
  exit 1
fi

export PATH="$(dirname "$BUN_BIN"):$PATH"

if [ "${SKIP_DEV_SERVER_START:-0}" = "1" ]; then
  echo "Skipping dev server startup because SKIP_DEV_SERVER_START=1."
  echo "Electron will attach to the existing server at http://localhost:$PORT."
  exit 0
fi

# If something is already listening on $PORT, reuse it and exit so the
# Electron renderer attaches to the existing server instead of double-starting.
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Detected existing server on port $PORT — reusing it."
  exit 0
fi

# Start the frontend watcher in the background. Its output is teed into
# logs/build.log so a SIGILL from `--watch` (a known panic on this repo) is
# captured.
echo "Starting bun build --watch..."
"$BUN_BIN" run scripts/build.ts --watch > >(tee -a "$BUILD_LOG") 2>&1 &
BUILD_PID=$!

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$BUILD_PID" 2>/dev/null || true
  wait "$BUILD_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the first build to produce dist/index.html so a browser hitting
# `/` doesn't race against an empty dist.
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

# Replace the shell with the bridge server so callers see a single, stable
# PID serving the frontend + API. stderr/stdout are teed into logs/bridge.log
# so Bun's native panic trace (the real SIGILL cause) is always persisted.
exec env CLAUDE_UI_PORT="$PORT" "$BUN_BIN" server/index.ts > >(tee -a "$BRIDGE_LOG") 2>&1
