#!/bin/bash
# Install Claude Code UI bridge server as a macOS launchd service
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_DIR="$HOME/.claude/ui-server"
PLIST_NAME="com.claude-code-ui.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$SERVICE_DIR/logs"

# Find bun
BUN_PATH=$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
if [ ! -f "$BUN_PATH" ]; then
    echo "Error: Bun not found. Install it: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

echo "=== Installing Claude Code UI Server ==="

# Create service directory
mkdir -p "$SERVICE_DIR" "$LOG_DIR"

# Bundle server
echo "Bundling server..."
cd "$PROJECT_DIR"
"$BUN_PATH" build ./server/index.ts --outfile "$SERVICE_DIR/server.js" --target bun --minify
echo "  → $SERVICE_DIR/server.js ($(du -h "$SERVICE_DIR/server.js" | cut -f1))"

# Copy bun binary
echo "Copying Bun binary..."
cp "$BUN_PATH" "$SERVICE_DIR/bun"
chmod +x "$SERVICE_DIR/bun"

# Unload existing service if running
if launchctl list | grep -q "$PLIST_NAME"; then
    echo "Stopping existing service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Create launchd plist
echo "Creating launchd plist..."
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$SERVICE_DIR/bun</string>
        <string>run</string>
        <string>$SERVICE_DIR/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_UI_PORT</key>
        <string>3111</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo v22.0.0)/bin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>
    <key>WorkingDirectory</key>
    <string>$HOME</string>
</dict>
</plist>
EOF

# Load service
echo "Starting service..."
launchctl load "$PLIST_PATH"

# Verify
sleep 1
if launchctl list | grep -q "$PLIST_NAME"; then
    echo ""
    echo "=== Service installed and running ==="
    echo "  Port: 3111"
    echo "  Logs: $LOG_DIR/"
    echo "  Config: $PLIST_PATH"
    echo ""
    echo "  Test: curl http://localhost:3111/health"
    echo "  Uninstall: ./scripts/uninstall-service.sh"
else
    echo "Error: Service failed to start. Check logs at $LOG_DIR/"
    exit 1
fi
