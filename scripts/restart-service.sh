#!/bin/bash
# Rebuild and restart the Claude Code UI bridge server service
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_DIR="$HOME/.claude/ui-server"
PLIST_NAME="com.claude-code-ui.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

BUN_PATH=$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")

echo "Rebuilding server..."
cd "$PROJECT_DIR"
"$BUN_PATH" build ./server/index.ts --outfile "$SERVICE_DIR/server.js" --target bun --minify

echo "Restarting service..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true
sleep 1
launchctl load "$PLIST_PATH"

sleep 1
curl -s http://localhost:3100/health && echo " ✓" || echo " ✗ Service failed to start"
