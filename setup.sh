#!/bin/bash

# Edge Agent Setup Script
# This script guides you through setting up the Mac mini edge agent

set -e

echo "==========================================="
echo "Edge Agent Setup"
echo "==========================================="
echo

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed"
    echo "Please install Node.js first:"
    echo "  brew install node"
    echo "Or visit: https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node --version)
echo "✅ Node.js $NODE_VERSION is installed"
echo

# Check if in correct directory
if [ ! -f "package.json" ]; then
    echo "❌ Please run this script from the edge-relay directory"
    exit 1
fi

# Install dependencies
echo "Installing dependencies..."
npm install
echo "✅ Dependencies installed"
echo

# Check for .env file
if [ ! -f ".env" ]; then
    echo "Creating .env file from template..."
    cp .env.example .env
    echo "⚠️  Please edit .env and add:"
    echo "   - EDGE_SECRET (shared secret from backend team)"
    echo "   - USER_PHONE (E.164, e.g. +13107404018)"
    echo "   - EDGE_AGENT_ID (e.g. edge_13107404018)"
    echo "   - REGISTRATION_TOKEN (if your flow still requires it)"
    echo
    read -p "Press Enter after you've edited .env..."
fi

# Check config.yaml
echo "Checking config.yaml..."
PHONE=$(grep "user_phone:" config.yaml | cut -d'"' -f2)
if [ "$PHONE" == "+15551234567" ]; then
    echo "⚠️  Please update user_phone in config.yaml with your actual phone number"
    read -p "Press Enter after you've edited config.yaml..."
fi

# Build project
echo "Building project..."
npm run build
echo "✅ Project built successfully"
echo

# Check Messages DB access
MESSAGES_DB="$HOME/Library/Messages/chat.db"
if [ ! -f "$MESSAGES_DB" ]; then
    echo "❌ Messages database not found at $MESSAGES_DB"
    echo "Make sure Messages.app is configured with an Apple ID"
    exit 1
fi

# Try to access Messages DB
if sqlite3 "$MESSAGES_DB" "SELECT COUNT(*) FROM message;" &> /dev/null; then
    echo "✅ Messages database is accessible"
else
    echo "❌ Cannot access Messages database"
    echo "Please grant Full Disk Access:"
    echo "  1. System Preferences → Security & Privacy → Privacy"
    echo "  2. Select 'Full Disk Access'"
    echo "  3. Add Terminal (or iTerm)"
    exit 1
fi

echo
echo "==========================================="
echo "✅ Setup complete!"
echo "==========================================="
echo
echo "Next steps:"
echo "  1. Start the edge agent: npm start"
echo "  2. Or run in dev mode: npm run dev"
echo "  3. Check logs: tail -f edge-agent.log"
echo
echo "To run automatically on startup:"
echo "  1. Copy LaunchAgent: cp com.archety.edge-agent.plist ~/Library/LaunchAgents/"
echo "  2. Load service: launchctl load ~/Library/LaunchAgents/com.archety.edge-agent.plist"
echo
