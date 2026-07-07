#!/usr/bin/env bash
# End-to-end "ship a new build to /Applications" pipeline for the Electron app.
# Intended to be invoked from a terminal (foreground), not from inside the
# running app — see scripts/electron-replace-app.sh for that path.
#
# Steps:
#   1. Full clean of build artifacts (rules out the stale-output races we've
#      hit before, where a previous bundle shipped a half-built dist/).
#   2. Build the frontend (dist/).
#   3. Sanity-check dist/ has the files server/index.ts expects to serve.
#   4. Bundle the bun sidecar + server.js into electron/resources/.
#   5. Compile the Electron main process to electron-dist/.
#   6. Run electron-builder to produce the .app + DMG under electron-out/.
#   7. Sanity-check that the produced .app contains dist/index.html.
#   8. Quit any running /Applications/Codiby Code.app, replace it, relaunch.
#
# Wired to `bun run electron:build:replace`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

INSTALLED_APP="/Applications/Codiby Code.app"
PROC_PATTERN="Codiby Code.app/Contents/MacOS/Codiby Code"
SIDECAR_PATTERN="Codiby Code.app/Contents/Resources/server.js"

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# 0. Kill any frontend watchers (they race with our build and can leave
#    dist/ half-populated mid-`rm`/-`cp`, so electron-builder snapshots an
#    incomplete tree).
# -----------------------------------------------------------------------------
step "Killing stray frontend watchers"
if pgrep -f "scripts/build\.ts --watch" >/dev/null; then
  pkill -TERM -f "scripts/build\.ts --watch" || true
  sleep 1
  pkill -KILL -f "scripts/build\.ts --watch" 2>/dev/null || true
  info "killed bun --watch on scripts/build.ts"
else
  info "none running"
fi

# -----------------------------------------------------------------------------
# 1. Clean
# -----------------------------------------------------------------------------
step "Cleaning build artifacts"
rm -rf \
  "$REPO_ROOT/dist" \
  "$REPO_ROOT/electron-dist" \
  "$REPO_ROOT/electron-out" \
  "$REPO_ROOT/packages/desktop/resources/server.js" \
  "$REPO_ROOT/packages/desktop/resources/bun" \
  "$REPO_ROOT/packages/desktop/resources/bun.exe"
info "removed dist/ electron-dist/ electron-out/ electron/resources/{server.js,bun}"

# -----------------------------------------------------------------------------
# 2. Build the frontend (writes dist/)
# -----------------------------------------------------------------------------
step "Building frontend (dist/)"
bun run build-server

# -----------------------------------------------------------------------------
# 3. Sanity-check dist/
# -----------------------------------------------------------------------------
step "Verifying dist/ layout"
for f in \
  "$REPO_ROOT/dist/index.html" \
  "$REPO_ROOT/dist/m/index.html" \
  "$REPO_ROOT/dist/assets" \
  "$REPO_ROOT/dist/runtime"
do
  [ -e "$f" ] || fail "expected $f after build-server"
done
info "dist/ looks complete"

# -----------------------------------------------------------------------------
# 4. Bundle bun sidecar + server.js → electron/resources/
# -----------------------------------------------------------------------------
step "Bundling bun sidecar + server.js"
bash "$REPO_ROOT/scripts/electron-bundle-resources.sh"

# -----------------------------------------------------------------------------
# 5. Compile Electron main → electron-dist/
# -----------------------------------------------------------------------------
step "Compiling Electron main process"
bun run electron:build:main

# -----------------------------------------------------------------------------
# 6. Package with electron-builder
# -----------------------------------------------------------------------------
step "Packaging with electron-builder (mac dmg)"
bunx electron-builder --mac dmg

# -----------------------------------------------------------------------------
# 7. Verify the produced bundle
# -----------------------------------------------------------------------------
step "Verifying packaged .app"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PACKAGED_APP="$REPO_ROOT/electron-out/mac-arm64/Codiby Code.app" ;;
  x86_64) PACKAGED_APP="$REPO_ROOT/electron-out/mac/Codiby Code.app" ;;
  *)      PACKAGED_APP="$REPO_ROOT/electron-out/mac-arm64/Codiby Code.app" ;;
esac
if [ ! -d "$PACKAGED_APP" ]; then
  PACKAGED_APP="$(ls -dt "$REPO_ROOT"/electron-out/*/"Codiby Code.app" 2>/dev/null | head -n 1 || true)"
fi
[ -d "$PACKAGED_APP" ] || fail "no .app bundle found under electron-out/"
for f in \
  "$PACKAGED_APP/Contents/Resources/dist/index.html" \
  "$PACKAGED_APP/Contents/Resources/dist/m/index.html" \
  "$PACKAGED_APP/Contents/Resources/server.js" \
  "$PACKAGED_APP/Contents/Resources/bun"
do
  [ -e "$f" ] || fail "missing in bundle: $f"
done
info "bundle: $PACKAGED_APP"

# -----------------------------------------------------------------------------
# 8. Replace installed app + relaunch
# -----------------------------------------------------------------------------
step "Replacing $INSTALLED_APP"

was_running=0
if pgrep -f "$PROC_PATTERN" >/dev/null; then
  was_running=1
  info "sending quit AppleEvent"
  osascript -e 'tell application "Codiby Code" to quit' 2>/dev/null || true
  info "waiting up to 12s for graceful exit"
  for i in $(seq 1 24); do
    if ! pgrep -f "$PROC_PATTERN" >/dev/null; then break; fi
    sleep 0.5
  done
  if pgrep -f "$PROC_PATTERN" >/dev/null; then
    info "still alive — SIGTERM"
    pkill -TERM -f "$PROC_PATTERN" || true
    sleep 2
  fi
  if pgrep -f "$PROC_PATTERN" >/dev/null; then
    info "still alive — SIGKILL"
    pkill -KILL -f "$PROC_PATTERN" || true
    sleep 1
  fi
fi
# Reap any orphan bun sidecars (they can outlive the shell on crashes).
pkill -KILL -f "$SIDECAR_PATTERN" 2>/dev/null || true

rm -rf "$INSTALLED_APP"
cp -R "$PACKAGED_APP" "$INSTALLED_APP"
xattr -cr "$INSTALLED_APP" 2>/dev/null || true

if [ "$was_running" = "1" ]; then
  info "relaunching"
else
  info "launching (wasn't running before)"
fi
open "$INSTALLED_APP"

printf '\n\033[1;32m== Done — %s installed and launched.\033[0m\n' "$INSTALLED_APP"
