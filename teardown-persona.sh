#!/bin/bash
# =============================================================================
# teardown-persona.sh — Remove an edge agent persona from this Mac
#
# Usage:
#   sudo ./teardown-persona.sh --persona-id vex
#   sudo ./teardown-persona.sh --persona-id vex --delete-user
# =============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_done()  { echo -e "  ${GREEN}[done]${NC} $1"; }

PORT_REGISTRY="/usr/local/etc/archety-edge-ports.json"
PERSONA_ID=""
SHARD_ID="1"
DELETE_USER=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --persona-id)    PERSONA_ID="$2"; shift 2 ;;
    --shard-id)      SHARD_ID="$2"; shift 2 ;;
    --delete-user)   DELETE_USER=true; shift ;;
    --help|-h)
      echo "Usage: sudo $0 --persona-id <id> [--shard-id <n>] [--delete-user]"
      echo ""
      echo "  --persona-id    Persona to remove (e.g., vex)"
      echo "  --shard-id      Shard number (default: 1)"
      echo "  --delete-user   Also delete the macOS user account and home directory"
      exit 0
      ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$PERSONA_ID" ]]; then
  log_error "--persona-id is required"
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  log_error "This script must be run with sudo"
  exit 1
fi

MAC_USER="${PERSONA_ID}${SHARD_ID}"
PLIST_LABEL="com.archety.edge-${PERSONA_ID}${SHARD_ID}"
PLIST_PATH="/Library/LaunchDaemons/${PLIST_LABEL}.plist"

echo ""
echo -e "${BOLD}Tearing down edge agent: ${PERSONA_ID}${NC}"
echo ""

# --- Stop and remove LaunchDaemon ---
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  log_info "Stopping service..."
  launchctl bootout "system/${PLIST_LABEL}" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  log_done "Service stopped"
else
  log_warn "Service '${PLIST_LABEL}' not running"
fi

if [[ -f "$PLIST_PATH" ]]; then
  rm -f "$PLIST_PATH"
  log_done "Plist removed: ${PLIST_PATH}"
else
  log_warn "Plist not found: ${PLIST_PATH}"
fi

# Clean up legacy daemon if this persona is sage
if [[ "$PERSONA_ID" == "sage" ]]; then
  LEGACY_LABEL="com.sage.edge-agent"
  LEGACY_PLIST="/Library/LaunchDaemons/${LEGACY_LABEL}.plist"
  if launchctl list 2>/dev/null | grep -q "$LEGACY_LABEL"; then
    log_info "Stopping legacy daemon: ${LEGACY_LABEL}"
    launchctl bootout "system/${LEGACY_LABEL}" 2>/dev/null || true
    launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
    log_done "Legacy daemon stopped"
  fi
  if [[ -f "$LEGACY_PLIST" ]]; then
    rm -f "$LEGACY_PLIST"
    log_done "Legacy plist removed: ${LEGACY_PLIST}"
  fi
fi

# --- Kill any remaining processes ---
pkill -f "node.*${MAC_USER}.*archety-edge" 2>/dev/null || true

# --- Remove from port registry ---
if [[ -f "$PORT_REGISTRY" ]]; then
  python3 -c "
import json
with open('$PORT_REGISTRY') as f:
    registry = json.load(f)
if '$PERSONA_ID' in registry:
    del registry['$PERSONA_ID']
with open('$PORT_REGISTRY', 'w') as f:
    json.dump(registry, f, indent=2)
"
  log_done "Removed from port registry"
fi

# --- Optionally delete macOS user ---
if [[ "$DELETE_USER" == true ]]; then
  if dscl . -read "/Users/${MAC_USER}" &>/dev/null; then
    log_warn "Deleting macOS user '${MAC_USER}' and home directory..."
    sysadminctl -deleteUser "$MAC_USER" -secure 2>&1 || true
    log_done "User '${MAC_USER}' deleted"
  else
    log_warn "User '${MAC_USER}' does not exist"
  fi
else
  log_info "macOS user '${MAC_USER}' preserved (use --delete-user to remove)"
  log_info "Project files preserved at /Users/${MAC_USER}/Code/archety-edge"
fi

echo ""
echo -e "${GREEN}${BOLD}Teardown complete: ${PERSONA_ID}${NC}"
echo ""
