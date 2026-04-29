#!/bin/bash
# Install or update the Codiby Code bridge server as a macOS launchd service.
# All runtime data lives under $HOME/.codiby/ — bundled server.js, pinned bun
# binary, built frontend, logs, and the port-discovery file consumed by the
# Tauri app. Interactive PTYs use Bun.Terminal (Bun >= 1.3.5) directly — no
# Node helper, no node-pty.
#
# Safe to re-run: if the service is already bootstrapped under the same label,
# this script overwrites files in place and reloads the LaunchAgent so the new
# plist takes effect.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

SERVICE_DIR="$HOME/.codiby"
LOG_DIR="$SERVICE_DIR/logs"
PORT_FILE="$SERVICE_DIR/server.port"

PORT="${CLAUDE_UI_PORT:-3111}"
PLIST_LABEL="com.codiby.code.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
SERVICE_TARGET="$DOMAIN/$PLIST_LABEL"

BUN_PATH="$(command -v bun || echo "$HOME/.bun/bin/bun")"
if [ ! -x "$BUN_PATH" ]; then
    echo "Error: bun not found. Install with:" >&2
    echo "  curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

INSTALLED=0
if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
    INSTALLED=1
    echo "=== Updating Codiby Code service (already installed) ==="
else
    echo "=== Installing Codiby Code service ==="
fi

mkdir -p "$SERVICE_DIR" "$LOG_DIR"

echo "-- Building frontend"
( cd "$PROJECT_DIR" && "$BUN_PATH" run scripts/build.ts ) >/dev/null

echo "-- Bundling server.js"
"$BUN_PATH" build "$PROJECT_DIR/server/index.ts" \
    --outfile "$SERVICE_DIR/server.js" \
    --target bun --minify >/dev/null

echo "-- Pinning bun binary"
cp "$BUN_PATH" "$SERVICE_DIR/bun"
chmod +x "$SERVICE_DIR/bun"

echo "-- Cleaning legacy PTY helper"
rm -f "$SERVICE_DIR/pty-helper.mjs"
rm -rf "$SERVICE_DIR/node_modules/node-pty"

echo "-- Copying dist/"
rm -rf "$SERVICE_DIR/dist"
cp -R "$PROJECT_DIR/dist" "$SERVICE_DIR/dist"

echo "-- Writing LaunchAgent plist"
NODE_VER="$(node -v 2>/dev/null || echo v22.0.0)"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$SERVICE_DIR/bun</string>
        <string>run</string>
        <string>$SERVICE_DIR/server.js</string>
        <string>--spawned-by=service</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_UI_PORT</key>
        <string>$PORT</string>
        <key>CODIBY_CODE_PORT_FILE</key>
        <string>$PORT_FILE</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.nvm/versions/node/$NODE_VER/bin</string>
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

# Reload so the updated plist is re-read. `kickstart -k` alone doesn't re-read
# the plist — it only restarts the process — so an update needs bootout first.
if [ "$INSTALLED" -eq 1 ]; then
    echo "-- Reloading service"
    launchctl bootout "$SERVICE_TARGET" 2>/dev/null || true
fi
echo "-- Bootstrapping service"
# bootout is async w.r.t. the domain; bootstrap can race with it and return
# error 5 "Input/output error". Retry briefly before giving up.
for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "$DOMAIN" "$PLIST_PATH" 2>/dev/null; then
        break
    fi
    if [ "$attempt" -eq 5 ]; then
        echo "Error: launchctl bootstrap failed after $attempt attempts" >&2
        launchctl bootstrap "$DOMAIN" "$PLIST_PATH"   # run once more to surface the error
        exit 1
    fi
    sleep 0.5
done

# Wait for port-file so we can report the real port (it may differ from $PORT
# if something else was holding it when Bun.serve fell back).
for _ in $(seq 1 30); do
    [ -f "$PORT_FILE" ] && break
    sleep 0.2
done

RUN_PORT="$(cat "$PORT_FILE" 2>/dev/null || echo "$PORT")"

echo
echo "=== done ==="
echo "  Service:    $PLIST_LABEL"
echo "  Data dir:   $SERVICE_DIR"
echo "  Port file:  $PORT_FILE"
echo "  Logs:       $LOG_DIR"
echo "  Listening:  http://localhost:$RUN_PORT"
echo "  Health:     curl -fsS http://localhost:$RUN_PORT/health && echo"
