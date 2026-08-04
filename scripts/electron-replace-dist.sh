#!/usr/bin/env bash
# Fast "ship frontend + sidecar" path for the installed macOS Electron app —
# everything short of recompiling the Electron main process / repackaging.
#
# The packaged app serves its UI from Contents/Resources/dist and runs the bun
# sidecar from Contents/Resources/server.js. A change to either only needs that
# artifact swapped — no electron-builder, no main-process recompile, no DMG.
# Use `bun run electron:build:replace` only when the Electron main process or
# the native resources (bun/rg/swagger) changed.
#
# Steps:
#   1. Rebuild dist/ (bun run build-server).
#   2. Sanity-check dist/ has what server/index.ts serves.
#   3. rsync --delete dist/ into the installed app's Resources/dist.
#   4. Rebundle server.js and swap it in if it changed (--no-server to skip).
#   5. If the app is running, reload its window(s) so the new bundle loads.
#      A server.js change forces a full restart instead (the bun sidecar can't
#      hot-reload). Flags: --no-reload (leave it), --restart (always relaunch).
#
# Wired to `bun run electron:replace:dist`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

INSTALLED_APP="${CODIBY_APP_PATH:-/Applications/Codiby Code.app}"
APP_DIST="$INSTALLED_APP/Contents/Resources/dist"
APP_SERVER="$INSTALLED_APP/Contents/Resources/server.js"

RELOAD_MODE="reload"   # reload | restart | none
SKIP_SERVER=0          # --no-server: only swap dist/, leave server.js alone
for arg in "$@"; do
  case "$arg" in
    --no-reload) RELOAD_MODE="none" ;;
    --restart)   RELOAD_MODE="restart" ;;
    --reload)    RELOAD_MODE="reload" ;;
    --no-server) SKIP_SERVER=1 ;;
    *) echo "unknown arg: $arg (use --no-reload | --restart | --reload | --no-server)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# macOS pgrep does not reliably match argv paths containing spaces, so the
# previous process-path check missed a running "Codiby Code.app" and left its
# old bun sidecar alive after replacing server.js.
app_is_running() {
  [ "$(osascript -e 'application "Codiby Code" is running' 2>/dev/null || true)" = "true" ]
}

app_pid() {
  osascript -e 'tell application "System Events" to get unix id of first process whose name is "Codiby Code"' 2>/dev/null || true
}

sidecar_pid_for_app() {
  local parent_pid="$1"
  [ -n "$parent_pid" ] || return 0
  ps -axo pid=,ppid=,command= | while read -r pid ppid command; do
    if [ "$ppid" = "$parent_pid" ]; then
      case "$command" in
        *"/Contents/Resources/server.js --spawned-by=app") printf '%s\n' "$pid" ;;
      esac
    fi
  done
}

[ -d "$INSTALLED_APP" ] || fail "installed app not found: $INSTALLED_APP (set CODIBY_APP_PATH to override)"
[ -d "$INSTALLED_APP/Contents/Resources/dist" ] || fail "app has no Resources/dist — is this a packaged build?"

# -----------------------------------------------------------------------------
# 1. Build the frontend (writes dist/)
# -----------------------------------------------------------------------------
step "Building frontend (dist/)"
bun run build-server

# -----------------------------------------------------------------------------
# 2. Sanity-check dist/
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
# 3. Replace the app's dist (mirror exactly — drop stale hashed assets)
# -----------------------------------------------------------------------------
step "Replacing $APP_DIST"
rsync -a --delete "$REPO_ROOT/dist/" "$APP_DIST/"
xattr -cr "$INSTALLED_APP" 2>/dev/null || true
info "dist swapped"

# -----------------------------------------------------------------------------
# 4. Rebundle + swap the bun sidecar (server.js) when server/ changed.
#    Mirrors the `bun build` in electron-bundle-resources.sh — just the script,
#    not bun/rg/swagger (those don't change for a code edit). If the bundle
#    actually changed, the sidecar must restart (a window reload won't reload
#    the bun process), so we force a full app restart below.
# -----------------------------------------------------------------------------
SERVER_CHANGED=0
if [ "$SKIP_SERVER" = "0" ]; then
  step "Rebundling server.js"
  [ -f "$APP_SERVER" ] || fail "app has no Resources/server.js — packaged build expected"
  TMP_SERVER="$(mktemp -t codiby-server).js"
  trap 'rm -f "$TMP_SERVER"' EXIT
  bun build "$REPO_ROOT/packages/core/index.ts" --outfile "$TMP_SERVER" --target bun --minify >/dev/null
  before="$(shasum -a 256 "$APP_SERVER" | awk '{print $1}')"
  after="$(shasum -a 256 "$TMP_SERVER" | awk '{print $1}')"
  if [ "$before" != "$after" ]; then
    cp "$TMP_SERVER" "$APP_SERVER"
    xattr -cr "$INSTALLED_APP" 2>/dev/null || true
    SERVER_CHANGED=1
    info "server.js updated (sidecar restart required)"
  else
    info "server.js unchanged"
  fi
else
  info "skipping server.js (--no-server)"
fi

# -----------------------------------------------------------------------------
# 5. Make the running app pick it up
# -----------------------------------------------------------------------------
if ! app_is_running; then
  step "App not running — nothing to reload"
  info "next launch will load the new bundle"
  printf '\n\033[1;32m== Done — replaced in %s.\033[0m\n' "$INSTALLED_APP"
  exit 0
fi

# A server.js change can only take effect by restarting the bun sidecar, which
# the Electron main owns — a renderer ⌘R reload won't touch it. Promote reload
# → restart in that case (unless the caller explicitly asked for no reload).
if [ "$SERVER_CHANGED" = "1" ] && [ "$RELOAD_MODE" = "reload" ]; then
  info "server changed → upgrading reload to a full restart"
  RELOAD_MODE="restart"
fi

case "$RELOAD_MODE" in
  none)
    step "App is running — skipping reload (--no-reload)"
    if [ "$SERVER_CHANGED" = "1" ]; then
      info "server.js changed — fully restart the app for it to take effect"
    else
      info "use ⌘R in the window, or rerun without --no-reload, to load it"
    fi
    ;;
  restart)
    step "Restarting app"
    running_app_pid="$(app_pid)"
    running_sidecar_pid="$(sidecar_pid_for_app "$running_app_pid")"
    osascript -e 'tell application "Codiby Code" to quit' 2>/dev/null || true
    for _ in $(seq 1 24); do
      app_is_running || break
      sleep 0.5
    done
    if app_is_running; then
      running_app_pid="$(app_pid)"
      [ -z "$running_app_pid" ] || kill -TERM "$running_app_pid" 2>/dev/null || true
      sleep 1
    fi
    # Reap any orphan bun sidecar so the relaunch gets a clean port.
    [ -z "$running_sidecar_pid" ] || kill -KILL "$running_sidecar_pid" 2>/dev/null || true
    open "$INSTALLED_APP"
    info "relaunched"
    ;;
  reload)
    # Reload every BrowserWindow without restarting the process. Keystroke
    # ⌘R is the most reliable cross-version trigger for the focused window;
    # bring the app forward first so it lands on the right target.
    step "Reloading app window (⌘R)"
    osascript >/dev/null 2>&1 <<'OSA' || info "couldn't auto-reload — press ⌘R in the window"
tell application "Codiby Code" to activate
delay 0.3
tell application "System Events" to keystroke "r" using command down
OSA
    info "reloaded"
    ;;
esac

printf '\n\033[1;32m== Done — replaced in %s.\033[0m\n' "$INSTALLED_APP"
