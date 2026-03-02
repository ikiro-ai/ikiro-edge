#!/bin/bash
# Quick status check for edge agent

echo "Edge Agent Status"
echo "================="
echo ""

# Check for running instances (match both legacy edge-relay and new archety-edge paths)
PROCESSES=$(ps aux | grep -E "(edge-relay|archety-edge).*index.js" | grep -v grep || true)
INSTANCE_COUNT=$(echo "$PROCESSES" | grep -c . || true)

if [ -z "$PROCESSES" ]; then
    echo "Status: NOT RUNNING"
    echo ""
    echo "To start:"
    echo "  sudo launchctl kickstart system/com.archety.edge-<persona><shard>"
    echo "  (e.g., system/com.archety.edge-sage1)"
    exit 1
fi

if [ "$INSTANCE_COUNT" -eq 1 ]; then
    ROOT_COUNT=$(echo "$PROCESSES" | grep -c "^root" || true)
    if [ "$ROOT_COUNT" -eq 1 ]; then
        echo "Status: RUNNING (LaunchAgent)"
        PID=$(echo "$PROCESSES" | awk '{print $2}')
        echo "PID: $PID"
    else
        echo "Status: RUNNING (Manual - not LaunchAgent)"
        PID=$(echo "$PROCESSES" | awk '{print $2}')
        echo "PID: $PID"
    fi
else
    echo "Status: MULTIPLE INSTANCES ($INSTANCE_COUNT)"
    echo ""
    echo "WARNING: Duplicate instances detected!"
    echo "This causes duplicate messages to be sent to backend."
    echo ""
    echo "Run this to clean up:"
    echo "  ./check-duplicates.sh"
    echo ""
    echo "Running instances:"
    echo "$PROCESSES"
fi

echo ""
echo "Recent logs:"
echo "------------"
# Try to find any persona's log directory
LOG_FOUND=false
for LOG_DIR in /Users/*/Code/archety-edge/logs /Users/sage1/Code/edge-relay/logs; do
    if [ -f "$LOG_DIR/edge-agent.out.log" ]; then
        echo "($LOG_DIR):"
        tail -5 "$LOG_DIR/edge-agent.out.log" 2>/dev/null
        LOG_FOUND=true
    fi
done
if [ "$LOG_FOUND" = false ]; then
    echo "No logs found"
fi
