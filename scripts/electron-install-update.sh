#!/bin/bash
# Privileged auto-update installer for the macOS Electron app.
#
# Invoked by the running app via:
#   osascript -e 'do shell script "/bin/bash <this> <dmg>" with administrator privileges'
# so it runs as ROOT (the macOS auth dialog is the "sudo" prompt the user sees).
#
#   1. quit the running /Applications/Codiby Code.app (graceful → TERM → KILL),
#   2. mount the downloaded .dmg, copy the fresh bundle into /Applications,
#   3. clear quarantine + chown to the console user so the next update needs
#      no extra elevation,
#   4. relaunch the app AS THE CONSOLE USER (not root).
#
# Progress is appended to /tmp/codiby-update.log.
set -u

DMG="${1:?usage: electron-install-update.sh <dmg-path>}"
APP="/Applications/Codiby Code.app"
LOG=/tmp/codiby-update.log

PROC_PATTERN="Codiby Code.app/Contents/MacOS/Codiby Code"
SIDECAR_PATTERN="Codiby Code.app/Contents/Resources/server.js"

# The script runs as root, but the GUI app must be quit/relaunched in the
# logged-in user's session — resolve that user and its uid.
CONSOLE_USER="$(stat -f%Su /dev/console 2>/dev/null)"
CONSOLE_UID="$(id -u "$CONSOLE_USER" 2>/dev/null)"

asuser() {
  # Run a command in the console user's GUI session when possible.
  if [ -n "${CONSOLE_UID:-}" ]; then
    launchctl asuser "$CONSOLE_UID" "$@"
  else
    "$@"
  fi
}

{
  echo "============================================================"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] electron-install-update.sh starting (pid=$$, whoami=$(whoami))"
  echo "[+] dmg:           $DMG"
  echo "[+] target:        $APP"
  echo "[+] console user:  ${CONSOLE_USER:-?} (uid=${CONSOLE_UID:-?})"

  if [ ! -f "$DMG" ]; then
    echo "[FAIL] dmg not found: $DMG"
    exit 1
  fi

  # --- 1. quit the running app -------------------------------------------------
  echo "[+] sending quit AppleEvent"
  asuser osascript -e 'tell application "Codiby Code" to quit' 2>/dev/null || true

  echo "[+] waiting up to 12s for graceful exit"
  for i in $(seq 1 24); do
    if ! pgrep -f "$PROC_PATTERN" >/dev/null; then
      echo "[+] graceful quit confirmed (~$((i / 2)) s)"
      break
    fi
    sleep 0.5
  done
  if pgrep -f "$PROC_PATTERN" >/dev/null; then
    echo "[!] still alive — SIGTERM"; pkill -TERM -f "$PROC_PATTERN" || true; sleep 2
  fi
  if pgrep -f "$PROC_PATTERN" >/dev/null; then
    echo "[!] still alive — SIGKILL"; pkill -KILL -f "$PROC_PATTERN" || true; sleep 1
  fi
  # Reap any orphaned bun sidecar holding the bridge port.
  pkill -KILL -f "$SIDECAR_PATTERN" 2>/dev/null || true

  # --- 2. mount + copy ---------------------------------------------------------
  echo "[+] mounting dmg"
  MOUNT_OUT="$(hdiutil attach "$DMG" -nobrowse -noautoopen 2>/dev/null)"
  MNT="$(echo "$MOUNT_OUT" | grep -o '/Volumes/.*' | head -n 1)"
  if [ -z "$MNT" ] || [ ! -d "$MNT" ]; then
    echo "[FAIL] could not mount dmg"
    exit 1
  fi
  echo "[+] mounted at:    $MNT"

  SRC="$(ls -d "$MNT"/*.app 2>/dev/null | head -n 1)"
  if [ -z "$SRC" ]; then
    echo "[FAIL] no .app inside dmg"
    hdiutil detach "$MNT" -quiet 2>/dev/null || true
    exit 1
  fi
  echo "[+] source bundle: $SRC"

  echo "[+] removing old bundle"
  rm -rf "$APP"
  echo "[+] copying new bundle"
  cp -R "$SRC" "$APP"

  # --- 3. de-quarantine + restore user ownership -------------------------------
  echo "[+] clearing quarantine xattrs"
  xattr -cr "$APP" 2>/dev/null || true
  if [ -n "${CONSOLE_USER:-}" ]; then
    echo "[+] chown -> $CONSOLE_USER"
    chown -R "$CONSOLE_USER" "$APP" 2>/dev/null || true
  fi

  echo "[+] detaching dmg"
  hdiutil detach "$MNT" -quiet 2>/dev/null || true
  rm -f "$DMG" 2>/dev/null || true

  # --- 4. relaunch as the user -------------------------------------------------
  echo "[+] relaunching as ${CONSOLE_USER:-current user}"
  asuser open "$APP"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] electron-install-update.sh done"
} >>"$LOG" 2>&1
