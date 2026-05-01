#!/bin/bash
# Detached self-replace for the macOS Tauri app:
#   1. quits the running /Applications/Codiby Code.app,
#   2. swaps in the freshly built bundle from src-tauri/target/release/...,
#   3. relaunches.
#
# Designed to be spawned with `nohup ... & disown` so it stays orphaned to
# PID 1 — it has to outlive the very app whose Bun sidecar invoked it.
#
# Live progress is appended to /tmp/codiby-replace.log; tail it from a real
# Terminal.app window if the relaunch never comes back.

set -u
LOG=/tmp/codiby-replace.log

# Resolve repo root from this script's location so the build output is found
# regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NEW_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/Codiby Code.app"
INSTALLED_APP="/Applications/Codiby Code.app"
PROC_PATTERN="Codiby Code.app/Contents/MacOS/codiby-code"
SIDECAR_PATTERN="Codiby Code.app/Contents/Resources/server.js"

{
  echo "============================================================"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] replace-app.sh starting (pid=$$)"
  echo "[+] new bundle:    $NEW_APP"
  echo "[+] target:        $INSTALLED_APP"

  if [ ! -d "$NEW_APP" ]; then
    echo "[FAIL] new bundle not found — run \`bun run tauri build\` first"
    exit 1
  fi

  # Brief grace so the spawning shell can return cleanly to the agent.
  sleep 2

  echo "[+] sending quit AppleEvent"
  osascript -e 'tell application "Codiby Code" to quit' 2>/dev/null || true

  echo "[+] waiting up to 12s for graceful exit"
  for i in $(seq 1 24); do
    if ! pgrep -f "$PROC_PATTERN" >/dev/null; then
      echo "[+] graceful quit confirmed (~${i}/2 s)"
      break
    fi
    sleep 0.5
  done

  if pgrep -f "$PROC_PATTERN" >/dev/null; then
    echo "[!] still alive after 12s — escalating to SIGTERM"
    pkill -TERM -f "$PROC_PATTERN" || true
    sleep 2
  fi
  if pgrep -f "$PROC_PATTERN" >/dev/null; then
    echo "[!] still alive after SIGTERM — SIGKILL"
    pkill -KILL -f "$PROC_PATTERN" || true
    sleep 1
  fi

  # Reap any stragglers — embedded Bun sidecar or claude children that
  # might have outlived the app shell.
  pkill -KILL -f "$SIDECAR_PATTERN" 2>/dev/null || true

  echo "[+] removing $INSTALLED_APP"
  rm -rf "$INSTALLED_APP"

  echo "[+] copying new bundle into /Applications"
  cp -R "$NEW_APP" "$INSTALLED_APP"

  echo "[+] clearing quarantine xattrs"
  xattr -cr "$INSTALLED_APP" 2>/dev/null || true

  echo "[+] re-launching"
  open "$INSTALLED_APP"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] replace-app.sh done"
} >>"$LOG" 2>&1
