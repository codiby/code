#!/bin/bash
# Detached self-replace for the macOS Electron app:
#   1. quits the running /Applications/Codiby Code.app,
#   2. swaps in the freshly built bundle from electron-out/...,
#   3. relaunches.
#
# Designed to be spawned with `nohup ... & disown` so it stays orphaned to
# PID 1 — it has to outlive the very app whose embedded bun sidecar invoked
# it.
#
# Live progress is appended to /tmp/codiby-electron-replace.log; tail it
# from a real Terminal.app window if the relaunch never comes back.

set -u
LOG=/tmp/codiby-electron-replace.log

# Resolve repo root from this script's location so the build output is found
# regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTALLED_APP="/Applications/Codiby Code.app"
# Match BOTH the main electron process and the embedded bun sidecar so we
# don't leave orphan bridge servers holding the port after the relaunch.
PROC_PATTERN="Codiby Code.app/Contents/MacOS/Codiby Code"
SIDECAR_PATTERN="Codiby Code.app/Contents/Resources/server.js"

# electron-builder with `target: dmg, arch: [arm64, x64]` produces multiple
# bundle directories under electron-out/. On Apple Silicon the arm64 copy
# is the one we want; fall back to the generic `mac/` (universal or x64)
# if arm64 isn't there. Pick whichever exists and is newest.
pick_app_bundle() {
  local arm64="$REPO_ROOT/electron-out/mac-arm64/Codiby Code.app"
  local x64="$REPO_ROOT/electron-out/mac-x64/Codiby Code.app"
  local universal="$REPO_ROOT/electron-out/mac-universal/Codiby Code.app"
  local generic="$REPO_ROOT/electron-out/mac/Codiby Code.app"
  local arch
  arch="$(uname -m)"
  if [ "$arch" = "arm64" ] && [ -d "$arm64" ]; then
    echo "$arm64"; return 0
  fi
  if [ "$arch" = "x86_64" ] && [ -d "$x64" ]; then
    echo "$x64"; return 0
  fi
  if [ -d "$universal" ]; then echo "$universal"; return 0; fi
  if [ -d "$generic" ];   then echo "$generic";   return 0; fi
  # Last resort: glob anything that looks like one and pick the newest.
  local found
  found="$(ls -dt "$REPO_ROOT"/electron-out/*/"Codiby Code.app" 2>/dev/null | head -n 1)"
  if [ -n "$found" ]; then echo "$found"; return 0; fi
  return 1
}

{
  echo "============================================================"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] electron-replace-app.sh starting (pid=$$)"

  if ! NEW_APP="$(pick_app_bundle)"; then
    echo "[FAIL] no .app bundle found under electron-out/ — run \`bun run electron:build\` first"
    exit 1
  fi

  echo "[+] new bundle:    $NEW_APP"
  echo "[+] target:        $INSTALLED_APP"

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

  # Reap any stragglers — embedded bun sidecar or claude children that
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

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] electron-replace-app.sh done"
} >>"$LOG" 2>&1
