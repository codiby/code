#!/bin/bash
# Uninstall the Codiby Code bridge server launchd service (macOS).
# Stops the LaunchAgent and removes its plist. Runtime data under
# $HOME/.codiby/ is left in place so reinstalling preserves the
# bundled bun, server.js, and logs — wipe the directory by hand if
# you want a clean slate.
set -euo pipefail

PLIST_LABEL="com.codiby.code.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
SERVICE_TARGET="$DOMAIN/$PLIST_LABEL"

echo "=== Uninstalling Codiby Code service ==="

if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
    echo "-- Stopping service"
    launchctl bootout "$SERVICE_TARGET" 2>/dev/null || true
fi

if [ -f "$PLIST_PATH" ]; then
    echo "-- Removing $PLIST_PATH"
    rm -f "$PLIST_PATH"
fi

# The previous product name was "taskr"; older installs registered the
# service under com.codiby.taskr.server. `launchctl bootout` of an
# unknown label fails silently — and the new uninstall path above only
# knows the codiby label — so without this block the legacy LaunchAgent
# re-bootstraps on every login.
LEGACY_LABEL="com.codiby.taskr.server"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
LEGACY_TASKR_TARGET="$DOMAIN/$LEGACY_LABEL"
if launchctl print "$LEGACY_TASKR_TARGET" >/dev/null 2>&1; then
    echo "-- Stopping legacy taskr service"
    launchctl bootout "$LEGACY_TASKR_TARGET" 2>/dev/null || true
fi
if [ -f "$LEGACY_PLIST" ]; then
    echo "-- Removing $LEGACY_PLIST"
    rm -f "$LEGACY_PLIST"
fi

echo
echo "=== Service uninstalled ==="
