#!/bin/bash
# Script to bundle Bun and server into the app

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SIDECAR_DIR="$PROJECT_DIR/src-tauri/sidecar"

# Find bun executable
BUN_PATH=$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")

if [ ! -f "$BUN_PATH" ]; then
    echo "Error: Bun not found at $BUN_PATH"
    echo "Please install Bun first: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Copy bun to sidecar directory
echo "Copying Bun from $BUN_PATH to $SIDECAR_DIR/bun"
cp "$BUN_PATH" "$SIDECAR_DIR/bun"
chmod +x "$SIDECAR_DIR/bun"

# Bundle server/ directory into a single JS file for the sidecar
echo "Bundling server into sidecar/server.js..."
cd "$PROJECT_DIR"
"$BUN_PATH" build ./server/index.ts --outfile "$SIDECAR_DIR/server.js" --target bun --minify

# Patch for dynamic port allocation (sidecar uses port 0)
sed -i '' 's/"3100"/"0"/g' "$SIDECAR_DIR/server.js"

# Copy PTY helper + node-pty for the interactive /terminal command.
# The helper is a plain Node script (Bun shells out to Node for PTY support).
echo "Copying pty-helper.mjs and node-pty..."
cp "$PROJECT_DIR/server/pty-helper.mjs" "$SIDECAR_DIR/pty-helper.mjs"
mkdir -p "$SIDECAR_DIR/node_modules"
rm -rf "$SIDECAR_DIR/node_modules/node-pty"
cp -R "$PROJECT_DIR/node_modules/node-pty" "$SIDECAR_DIR/node_modules/node-pty"
find "$SIDECAR_DIR/node_modules/node-pty/prebuilds" -name spawn-helper -exec chmod +x {} \; 2>/dev/null || true

# Ensure BRIDGE_SERVER_PORT output exists for Tauri to read
if ! grep -q 'BRIDGE_SERVER_PORT' "$SIDECAR_DIR/server.js"; then
  # Append at the very end — server.port is available after Bun.serve()
  echo "" >> "$SIDECAR_DIR/server.js"
fi

echo "Done! Bun and server.js have been bundled into the sidecar directory."
ls -lh "$SIDECAR_DIR/bun" "$SIDECAR_DIR/server.js"
