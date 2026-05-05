#!/bin/bash
# Build script for Portility Chrome Extension
# Usage: bash tools/build.sh
#
# Reads the version from src/manifest.json and creates
# releases/portility-X.X.X.zip containing only the src/ files.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Extract version from manifest.json
VERSION=$(grep '"version"' "$PROJECT_DIR/src/manifest.json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')

if [ -z "$VERSION" ]; then
  echo "ERROR: Could not read version from src/manifest.json"
  exit 1
fi

OUTPUT="$PROJECT_DIR/releases/portility-${VERSION}.zip"

echo "Building Portility v${VERSION}..."
echo "Output: $OUTPUT"

# Remove old zip if it exists
rm -f "$OUTPUT"

# Create zip from src/ contents
cd "$PROJECT_DIR/src"
powershell -Command "Compress-Archive -Path '*' -DestinationPath '$OUTPUT' -Force"

echo "Done! $(ls -la "$OUTPUT" | awk '{print $5}') bytes"
echo ""
echo "To publish: upload $OUTPUT to the Chrome Web Store developer console."
