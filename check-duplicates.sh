#!/bin/bash
# Edge Agent Duplicate Instance Checker and Cleaner
# Ensures only the LaunchDaemon instance is running

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_NAME="edge-relay"

echo "============================================================"
echo "Edge Agent Duplicate Instance Checker"
echo "============================================================"
echo ""

# Find all running instances
echo "Checking for running edge agent instances..."
echo ""

# Get all edge-relay and archety-edge index.js processes
PROCESSES=$(ps aux | grep -E "(edge-relay|archety-edge).*index.js" | grep -v grep || true)

if [ -z "$PROCESSES" ]; then
    echo "❌ No edge agent instances found running"
    echo ""
    echo "To start the service:"
    echo "  sudo launchctl kickstart system/com.archety.edge-<persona><shard>"
    exit 0
fi

# Count instances
INSTANCE_COUNT=$(echo "$PROCESSES" | wc -l | xargs)
echo "Found $INSTANCE_COUNT instance(s):"
echo ""
echo "$PROCESSES"
echo ""

if [ "$INSTANCE_COUNT" -eq 1 ]; then
    # Check if it's the LaunchDaemon
    ROOT_COUNT=$(echo "$PROCESSES" | grep -c "^root" || true)

    if [ "$ROOT_COUNT" -eq 1 ]; then
        echo "✅ Only one instance running (LaunchDaemon) - no duplicates found"
        echo ""
        PID=$(echo "$PROCESSES" | awk '{print $2}')
        echo "LaunchDaemon PID: $PID"
    else
        echo "⚠️  Only one instance running, but it's NOT the LaunchDaemon"
        echo ""
        echo "This might be a manually started instance."
        echo "Consider stopping it and using the LaunchDaemon instead:"
        echo ""
        PID=$(echo "$PROCESSES" | awk '{print $2}')
        echo "  kill $PID"
        echo "  sudo launchctl kickstart system/com.archety.edge-<persona><shard>"
    fi
    exit 0
fi

# Multiple instances found
echo "⚠️  DUPLICATE INSTANCES DETECTED!"
echo ""

# Identify LaunchDaemon (root) and user instances
ROOT_INSTANCES=$(echo "$PROCESSES" | grep "^root" || true)
USER_INSTANCES=$(echo "$PROCESSES" | grep -v "^root" || true)

ROOT_COUNT=$(echo "$ROOT_INSTANCES" | grep -v "^$" | wc -l | xargs)
USER_COUNT=$(echo "$USER_INSTANCES" | grep -v "^$" | wc -l | xargs)

echo "LaunchDaemon instances (root): $ROOT_COUNT"
if [ -n "$ROOT_INSTANCES" ]; then
    echo "$ROOT_INSTANCES"
fi
echo ""

echo "User instances (non-root): $USER_COUNT"
if [ -n "$USER_INSTANCES" ]; then
    echo "$USER_INSTANCES"
fi
echo ""

# Determine what to kill
if [ "$ROOT_COUNT" -ge 1 ]; then
    # LaunchDaemon is running - kill user instances
    echo "Strategy: Keep LaunchDaemon, kill user instances"
    echo ""

    if [ "$USER_COUNT" -ge 1 ]; then
        # Ask for confirmation
        read -p "Kill $USER_COUNT user instance(s)? [y/N] " -n 1 -r
        echo ""

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Killing user instances..."
            USER_PIDS=$(echo "$USER_INSTANCES" | awk '{print $2}')
            for PID in $USER_PIDS; do
                echo "  Killing PID $PID..."
                kill $PID 2>/dev/null || echo "    Failed to kill $PID (might already be dead)"
            done
            echo ""
            echo "✅ User instances killed"

            # Wait a moment for processes to die
            sleep 2

            # Verify
            echo ""
            echo "Verifying..."
            REMAINING=$(ps aux | grep -E "(edge-relay|archety-edge).*index.js" | grep -v grep | wc -l | xargs)
            if [ "$REMAINING" -eq 1 ]; then
                echo "✅ Success! Only LaunchDaemon instance remains"
            else
                echo "⚠️  $REMAINING instances still running. Check manually:"
                ps aux | grep -E "(edge-relay|archety-edge).*index.js" | grep -v grep
            fi
        else
            echo "Cancelled. No instances killed."
        fi
    fi
else
    # No LaunchDaemon running - multiple user instances
    echo "⚠️  No LaunchDaemon instance found!"
    echo "Multiple user instances are running."
    echo ""
    echo "Recommended action:"
    echo "  1. Kill all user instances:"
    echo "     pkill -u $(whoami) -f '(edge-relay|archety-edge).*index.js'"
    echo ""
    echo "  2. Start LaunchDaemon:"
    echo "     sudo launchctl kickstart system/com.archety.edge-<persona><shard>"
    echo ""
    read -p "Kill all user instances now? [y/N] " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Killing all user instances..."
        pkill -u $(whoami) -f "(edge-relay|archety-edge).*index.js" || echo "No processes to kill"
        sleep 2
        echo "✅ Done"
        echo ""
        echo "Now start the LaunchDaemon:"
        echo "  sudo launchctl kickstart system/com.archety.edge-<persona><shard>"
    else
        echo "Cancelled."
    fi
fi

echo ""
echo "============================================================"
echo "Current Status:"
echo "============================================================"
ps aux | grep -E "(edge-relay|archety-edge).*index.js" | grep -v grep || echo "No instances running"
echo ""
