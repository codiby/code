#!/usr/bin/env bash
# Detached restart of the Codiby Code bridge server.
#
# Meant to be launched with `setsid nohup ... &` from INSIDE a Claude session:
# the bridge is this session's ancestor, so the killer must not share its
# process group or it dies with the server before the restart happens.
set -u

DIR="/home/jovaz/codiby/code"
PORT="${CLAUDE_UI_PORT:-3111}"
LOG="$DIR/logs/restart-$(date +%Y%m%d-%H%M%S).log"
exec >>"$LOG" 2>&1 </dev/null

echo "[restart] start $(date) (pid $$, sid $(ps -o sid= -p $$))"

# Grace period so the session that launched us can finish streaming its
# goodbye message to the UI before we pull the rug.
sleep 12

# --- Kill the build watchers belonging to THIS repo (match by cwd, not just
# command line, so watchers from other projects are untouched).
for p in $(pgrep -f 'bun run scripts/build.ts --watch' || true); do
  if [ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$DIR" ]; then
    echo "[restart] killing build watcher $p"
    kill "$p" 2>/dev/null || true
  fi
done

# --- Kill the bridge (whatever is listening on $PORT).
BRIDGE_PID="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$BRIDGE_PID" ]; then
  echo "[restart] killing bridge $BRIDGE_PID"
  kill "$BRIDGE_PID" 2>/dev/null || true
fi

# --- Wait for the port to actually free up (run.sh reuses a busy port and
# would exit without restarting otherwise). Escalate to SIGKILL at 15 s.
for i in $(seq 1 30); do
  if ! lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 15 ] && [ -n "${BRIDGE_PID:-}" ]; then
    echo "[restart] bridge still up, SIGKILL"
    kill -9 "$BRIDGE_PID" 2>/dev/null || true
  fi
  sleep 1
done

if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "[restart] ERROR: port $PORT never freed, aborting relaunch"
  exit 1
fi

echo "[restart] port free, relaunching run.sh"
cd "$DIR"
setsid nohup bash run.sh >>"$LOG" 2>&1 </dev/null &

# Confirm it came back before declaring victory.
for _ in $(seq 1 60); do
  if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "[restart] server is back on port $PORT $(date)"
    exit 0
  fi
  sleep 1
done

echo "[restart] ERROR: server did not come back within 60 s — check logs/bridge.log"
exit 1
