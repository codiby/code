#!/bin/bash
# Uninstall Claude Code UI bridge server launchd service
set -e

PLIST_NAME="com.claude-code-ui.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
SERVICE_DIR="$HOME/.claude/ui-server"
PORT_FILE="$HOME/.claude/ui-server.port"

echo "=== Uninstalling Claude Code UI Server ==="

# Stop and unload service
if launchctl list | grep -q "$PLIST_NAME"; then
    echo "Stopping service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Remove plist
if [ -f "$PLIST_PATH" ]; then
    rm "$PLIST_PATH"
    echo "Removed $PLIST_PATH"
fi

# Remove port file
rm -f "$PORT_FILE"

# Remove service directory
if [ -d "$SERVICE_DIR" ]; then
    rm -rf "$SERVICE_DIR"
    echo "Removed $SERVICE_DIR"
fi

echo ""
echo "=== Service uninstalled ==="
