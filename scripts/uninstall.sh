#!/bin/bash
# Uninstall the Codiby Code bridge server launchd service (macOS).
# Removes the LaunchAgent, the plist, and all runtime data under $HOME/.codiby/.
set -euo pipefail

SERVICE_DIR="$HOME/.codiby"
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

if [ -d "$SERVICE_DIR" ]; then
    echo "-- Removing $SERVICE_DIR"
    rm -rf "$SERVICE_DIR"
fi

# Best-effort cleanup of the legacy ~/.claude/ui-server layout, kept here so
# upgraders from the pre-~/.codiby install don't need a second command.
LEGACY_DIR="$HOME/.claude/ui-server"
LEGACY_PORT="$HOME/.claude/ui-server.port"
if [ -d "$LEGACY_DIR" ] || [ -f "$LEGACY_PORT" ]; then
    echo "-- Removing legacy ~/.claude/ui-server artifacts"
    rm -rf "$LEGACY_DIR" "$LEGACY_PORT"
fi

# The previous product name was "taskr"; older installs registered the
# service under com.codiby.taskr.server with a data dir at ~/.taskr/.
# `launchctl bootout` of an unknown label fails silently — and the new
# uninstall path above only knows the codiby label — so without this block
# the legacy LaunchAgent re-bootstraps on every login.
LEGACY_LABEL="com.codiby.taskr.server"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
LEGACY_TASKR_DIR="$HOME/.taskr"
LEGACY_TASKR_TARGET="$DOMAIN/$LEGACY_LABEL"
if launchctl print "$LEGACY_TASKR_TARGET" >/dev/null 2>&1; then
    echo "-- Stopping legacy taskr service"
    launchctl bootout "$LEGACY_TASKR_TARGET" 2>/dev/null || true
fi
if [ -f "$LEGACY_PLIST" ]; then
    echo "-- Removing $LEGACY_PLIST"
    rm -f "$LEGACY_PLIST"
fi
if [ -d "$LEGACY_TASKR_DIR" ]; then
    echo "-- Removing $LEGACY_TASKR_DIR"
    rm -rf "$LEGACY_TASKR_DIR"
fi

echo
echo "=== Service uninstalled ==="
