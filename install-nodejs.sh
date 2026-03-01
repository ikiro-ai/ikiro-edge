#!/bin/bash

# Node.js Installation Script
# Run this to install Node.js on the Mac mini

set -e

echo "==========================================="
echo "Installing Node.js v20.11.0"
echo "==========================================="
echo

# Check if already downloaded
if [ ! -f "/tmp/node-v20.11.0.pkg" ]; then
    echo "Downloading Node.js installer..."
    curl -o /tmp/node-v20.11.0.pkg https://nodejs.org/dist/v20.11.0/node-v20.11.0.pkg
fi

echo "Installing Node.js (requires sudo password)..."
sudo installer -pkg /tmp/node-v20.11.0.pkg -target /

echo
echo "Verifying installation..."
/usr/local/bin/node --version
/usr/local/bin/npm --version

echo
echo "==========================================="
echo "Node.js installed successfully!"
echo "==========================================="
echo
echo "IMPORTANT: If upgrading Node.js, rebuild native modules in all project directories:"
echo ""
for PROJ_DIR in /Users/*/Code/archety-edge /Users/sage1/Code/edge-relay; do
    if [ -d "$PROJ_DIR/node_modules" ]; then
        echo "  Rebuilding native modules in $PROJ_DIR ..."
        (cd "$PROJ_DIR" && npm rebuild 2>&1) | tail -3
    fi
done
echo ""
echo "Next steps:"
echo "  1. Close and reopen your terminal (to update PATH)"
echo "  2. Run: npm install"
echo "  3. Run: npm rebuild   (ensures native modules match the new Node ABI)"
echo "  4. Run: npm run build"
echo "  5. Run: npm start"
echo
