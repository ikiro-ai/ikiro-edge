#!/bin/bash
# Installation script for edge-agent LaunchDaemon

set -e

echo "Installing edge-agent LaunchDaemon..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "This script must be run with sudo"
    exit 1
fi

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR"

# Get the user who invoked sudo (or current user if not using sudo)
REAL_USER="${SUDO_USER:-$USER}"

echo "Project directory: $PROJECT_DIR"
echo "Running as user: $REAL_USER"

# Ensure the project is built (admin portal server includes edge client)
ENTRY_FILE="$PROJECT_DIR/dist/admin-portal/server/index.js"
if [ ! -f "$ENTRY_FILE" ]; then
    echo "Error: Admin portal not built. Run 'npm run admin:build' first."
    exit 1
fi

# Create logs directory if it doesn't exist
mkdir -p "$PROJECT_DIR/logs"
chown "$REAL_USER:staff" "$PROJECT_DIR/logs"

# Stop the service if it's already running
if launchctl list | grep -q "com.sage.edge-agent"; then
    echo "Stopping existing service..."
    launchctl bootout system/com.sage.edge-agent 2>/dev/null || true
    launchctl unload /Library/LaunchDaemons/com.sage.edge-agent.plist 2>/dev/null || true
fi

# Generate plist file with dynamic paths
echo "Generating plist file with dynamic paths..."
PLIST_DEST="/Library/LaunchDaemons/com.sage.edge-agent.plist"

# Find node executable
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "Error: node not found in PATH. Please install Node.js first."
    exit 1
fi

echo "Using node at: $NODE_PATH"

# Get the user's home directory
USER_HOME=$(eval echo "~$REAL_USER")
echo "User home directory: $USER_HOME"

# Load environment variables from .env file
echo "Loading environment variables from .env..."
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "Error: .env file not found at $PROJECT_DIR/.env"
    echo "Please create .env file with required variables:"
    echo "  EDGE_SECRET=..."
    echo "  BACKEND_URL=..."
    echo "  USER_PHONE=..."
    exit 1
fi

# Read .env and extract variables (simple parsing - ignores comments and blank lines)
EDGE_SECRET=$(grep "^EDGE_SECRET=" "$PROJECT_DIR/.env" | cut -d '=' -f2-)
BACKEND_URL=$(grep "^BACKEND_URL=" "$PROJECT_DIR/.env" | cut -d '=' -f2-)
USER_PHONE=$(grep "^USER_PHONE=" "$PROJECT_DIR/.env" | cut -d '=' -f2-)
EDGE_AGENT_ID=$(grep "^EDGE_AGENT_ID=" "$PROJECT_DIR/.env" | cut -d '=' -f2-)
ADMIN_PORT=$(grep "^ADMIN_PORT=" "$PROJECT_DIR/.env" | cut -d '=' -f2-)

# Validate required variables
if [ -z "$EDGE_SECRET" ]; then
    echo "Error: EDGE_SECRET not found in .env"
    exit 1
fi

if [ -z "$BACKEND_URL" ]; then
    echo "Error: BACKEND_URL not found in .env"
    exit 1
fi

if [ -z "$USER_PHONE" ]; then
    echo "Error: USER_PHONE not found in .env"
    exit 1
fi

if [ -z "$EDGE_AGENT_ID" ]; then
    echo "Error: EDGE_AGENT_ID not found in .env"
    exit 1
fi

if [ -z "$ADMIN_PORT" ]; then
    echo "Error: ADMIN_PORT not found in .env"
    exit 1
fi

echo "Environment variables loaded:"
echo "  EDGE_SECRET: ${EDGE_SECRET:0:20}..."
echo "  BACKEND_URL: $BACKEND_URL"
echo "  USER_PHONE: $USER_PHONE"
echo "  EDGE_AGENT_ID: $EDGE_AGENT_ID"
echo "  ADMIN_PORT: $ADMIN_PORT"

# Create plist file
cat > "$PLIST_DEST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sage.edge-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$ENTRY_FILE</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>UserName</key>
    <string>$REAL_USER</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/edge-agent.out.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/edge-agent.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>HOME</key>
        <string>$USER_HOME</string>
        <key>EDGE_SECRET</key>
        <string>$EDGE_SECRET</string>
        <key>BACKEND_URL</key>
        <string>$BACKEND_URL</string>
        <key>USER_PHONE</key>
        <string>$USER_PHONE</string>
        <key>EDGE_AGENT_ID</key>
        <string>$EDGE_AGENT_ID</string>
        <key>ADMIN_PORT</key>
        <string>$ADMIN_PORT</string>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
EOF

chown root:wheel "$PLIST_DEST"
chmod 644 "$PLIST_DEST"

# Load and start the service
echo "Loading and starting service..."
launchctl load "$PLIST_DEST"

echo ""
echo "✅ Edge Agent LaunchDaemon installed successfully!"
echo ""
echo "The service will now start automatically on boot."
echo ""
echo "Useful commands:"
echo "  - Check status: sudo launchctl list | grep edge-agent"
echo "  - View logs: tail -f $PROJECT_DIR/logs/edge-agent.out.log"
echo "  - Stop service: sudo launchctl unload $PLIST_DEST"
echo "  - Start service: sudo launchctl load $PLIST_DEST"
echo ""
