#!/usr/bin/env bash
# Detached restart of the Codiby Code app — quit + relaunch from OUTSIDE the
# app's process tree, so it survives the app (and any in-app Claude session)
# being killed mid-restart. Use when you can't Cmd+Q physically.
#
# Run it detached so it outlives the shell that starts it:
#   nohup bash scripts/restart-codiby.sh >/tmp/codiby-restart.log 2>&1 & disown
#
# Sequence: free the standalone docs port → graceful quit → wait → force-kill
# stragglers → free the bridge port → relaunch a fresh instance (which loads the
# new main.js + server.js, i.e. the Hono bridge + integrated Swagger on 3112).
set -uo pipefail

APP_NAME="Codiby Code"
APP_PATH="/Applications/Codiby Code.app"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_PORT="${CLAUDE_UI_PORT:-3111}"
SWAGGER_PORT="${CODIBY_SWAGGER_PORT:-3112}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Give the launching shell time to exit so we're reparented to launchd (PPID 1)
# and won't be taken down when the app — and this session — are killed.
sleep 3
log "restart starting (ppid=$PPID)"

# 0. Stop the standalone docs server so the relaunched app can own 3112 itself.
bash "$ROOT/scripts/swagger-docs.sh" stop >/dev/null 2>&1 || true

# 1. Graceful quit.
log "asking '$APP_NAME' to quit"
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true

# 2. Wait for the app's processes to actually exit (up to ~25s).
for _ in $(seq 1 50); do
  pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1 || break
  sleep 0.5
done

# 3. Force-kill any stragglers (helpers, bridge sidecar).
log "force-killing stragglers"
pkill -f "$APP_PATH/Contents/" >/dev/null 2>&1 || true

# 4. Free the bridge port if the old sidecar is still squatting on it.
pids="$(lsof -nP -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
[ -n "$pids" ] && kill $pids 2>/dev/null || true
sleep 2

# 5. Relaunch a fresh instance.
log "relaunching $APP_PATH"
open "$APP_PATH" || open -a "$APP_NAME"

# 6. Wait for the new bridge + integrated Swagger to come up and report.
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$BRIDGE_PORT/health" >/dev/null 2>&1; then
    log "bridge up on :$BRIDGE_PORT"
    break
  fi
  sleep 1
done
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$SWAGGER_PORT/health" >/dev/null 2>&1; then
    log "swagger up on :$SWAGGER_PORT"
    break
  fi
  sleep 1
done
log "restart done"
