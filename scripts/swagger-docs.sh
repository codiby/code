#!/usr/bin/env bash
# Standalone Swagger docs server, fully detached from the Electron app.
#
# The app-spawned bridge dies when the app closes and is NOT auto-respawned, so
# its embedded docs server (3112) goes with it. This launcher runs the docs
# server as an orphaned background process (nohup + disown) that survives app
# restarts and the shell that started it. Idempotent: re-running replaces the
# previous instance.
#
#   bash scripts/swagger-docs.sh            # docs on 3112 → API on 3111
#   CODIBY_SWAGGER_PORT=4000 bash scripts/swagger-docs.sh
#   CLAUDE_UI_PORT=3211 bash scripts/swagger-docs.sh   # point spec at another API
#
# Stop it with:  bash scripts/swagger-docs.sh stop
set -euo pipefail

PORT="${CODIBY_SWAGGER_PORT:-3112}"
API_PORT="${CLAUDE_UI_PORT:-3111}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${CODIBY_SWAGGER_LOG:-/tmp/codiby-swagger-$PORT.log}"
PIDFILE="/tmp/codiby-swagger-$PORT.pid"
BUN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

stop_existing() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  # Also free the port if anything else is squatting on it.
  local pids
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  rm -f "$PIDFILE"
}

if [ "${1:-start}" = "stop" ]; then
  stop_existing
  echo "Swagger docs on :$PORT stopped."
  exit 0
fi

stop_existing
sleep 0.4

cd "$ROOT"
CLAUDE_UI_PORT="$API_PORT" CODIBY_SWAGGER_PORT="$PORT" \
  nohup "$BUN" run server/swagger.ts >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"
disown "$PID" 2>/dev/null || disown || true

# Wait for readiness.
for _ in $(seq 1 25); do
  if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo "Swagger docs detached on http://localhost:$PORT (spec → :$API_PORT) pid=$PID log=$LOG"
    exit 0
  fi
  sleep 0.2
done

echo "Swagger docs started (pid=$PID) but /health did not answer in time — check $LOG" >&2
exit 1
