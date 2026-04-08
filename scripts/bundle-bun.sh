#!/bin/bash
# Script to bundle Bun into the app

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

echo "Done! Bun has been bundled into the sidecar directory."
ls -lh "$SIDECAR_DIR/bun"
