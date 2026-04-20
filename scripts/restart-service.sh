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

# Copy PTY helper + its node-pty dependency for the interactive /terminal command.
# The helper is a plain Node script (Bun shells out to Node for PTY support).
echo "Copying pty-helper.mjs and node-pty..."
cp "$PROJECT_DIR/server/pty-helper.mjs" "$SERVICE_DIR/pty-helper.mjs"
mkdir -p "$SERVICE_DIR/node_modules"
rm -rf "$SERVICE_DIR/node_modules/node-pty"
cp -R "$PROJECT_DIR/node_modules/node-pty" "$SERVICE_DIR/node_modules/node-pty"
# Ensure prebuilt spawn-helper binary is executable (bun install sometimes strips this).
find "$SERVICE_DIR/node_modules/node-pty/prebuilds" -name spawn-helper -exec chmod +x {} \; 2>/dev/null || true

echo "Restarting service..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true
sleep 1
launchctl load "$PLIST_PATH"

sleep 1
curl -s http://localhost:3111/health && echo " ✓" || echo " ✗ Service failed to start"
