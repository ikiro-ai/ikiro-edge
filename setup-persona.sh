#!/bin/bash
# =============================================================================
# setup-persona.sh — Provision a new edge agent persona on this Mac
#
# Usage:
#   sudo ./setup-persona.sh \
#     --persona-id vex \
#     --phone "+14155559876" \
#     --edge-secret "your_shared_secret"
#
# Optional:
#   --backend-url "https://api.ikiro.ai"
#   --repo-url "git@github.com:rawrjustin/archety-edge.git"
#   --environment "production"
# =============================================================================

set -e

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "\n${BLUE}${BOLD}==> $1${NC}"; }
log_done()  { echo -e "  ${GREEN}[done]${NC} $1"; }

# --- Defaults ---
BACKEND_URL="https://api.ikiro.ai"
REPO_URL="https://github.com/rawrjustin/archety-edge.git"
ENVIRONMENT="production"
MACOS_PASSWORD="archety"
PORT_REGISTRY="/usr/local/etc/archety-edge-ports.json"
PERSONA_ID=""
PHONE=""
EDGE_SECRET=""

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --persona-id)   PERSONA_ID="$2";   shift 2 ;;
    --phone)        PHONE="$2";        shift 2 ;;
    --edge-secret)  EDGE_SECRET="$2";  shift 2 ;;
    --backend-url)  BACKEND_URL="$2";  shift 2 ;;
    --repo-url)     REPO_URL="$2";     shift 2 ;;
    --environment)  ENVIRONMENT="$2";  shift 2 ;;
    --help|-h)
      echo "Usage: sudo $0 --persona-id <id> --phone <E.164> --edge-secret <secret>"
      echo ""
      echo "Required:"
      echo "  --persona-id    Persona identifier (e.g., vex, echo, kael)"
      echo "  --phone         iMessage phone number in E.164 format (e.g., +14155559876)"
      echo "  --edge-secret   Shared secret for backend HMAC token authentication"
      echo ""
      echo "Optional:"
      echo "  --backend-url   Backend URL (default: prod)"
      echo "  --repo-url      Git repo URL (default: archety-edge)"
      echo "  --environment   production or development (default: production)"
      exit 0
      ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Validate required args ---
if [[ -z "$PERSONA_ID" ]]; then
  log_error "--persona-id is required"
  exit 1
fi

if [[ -z "$PHONE" ]]; then
  log_error "--phone is required"
  exit 1
fi

if [[ -z "$EDGE_SECRET" ]]; then
  log_error "--edge-secret is required"
  exit 1
fi

# --- Validate formats ---
if ! echo "$PERSONA_ID" | grep -qE '^[a-z][a-z0-9_]*$'; then
  log_error "persona-id must be lowercase alphanumeric (e.g., vex, echo, kael)"
  exit 1
fi

if ! echo "$PHONE" | grep -qE '^\+[1-9][0-9]{1,14}$'; then
  log_error "phone must be E.164 format (e.g., +14155559876)"
  exit 1
fi

# --- Check prerequisites ---
if [[ "$EUID" -ne 0 ]]; then
  log_error "This script must be run with sudo"
  exit 1
fi

REAL_USER="${SUDO_USER:-$USER}"

for cmd in node npm git; do
  if ! command -v "$cmd" &>/dev/null; then
    log_error "$cmd is required but not found in PATH"
    exit 1
  fi
done

# --- Derived values ---
MAC_USER="${PERSONA_ID}1"
USER_HOME="/Users/${MAC_USER}"
PROJECT_DIR="${USER_HOME}/Code/archety-edge"
NODE_PATH="$(which node)"
WEBSOCKET_URL="${BACKEND_URL/https:/wss:}"

echo ""
echo -e "${BOLD}Setting up edge agent for persona: ${PERSONA_ID}${NC}"
echo "  macOS user:   ${MAC_USER}"
echo "  Phone:        ${PHONE}"
echo "  Backend:      ${BACKEND_URL}"
echo "  Environment:  ${ENVIRONMENT}"
echo ""

# =============================================================================
# Step 1: Port assignment
# =============================================================================
log_step "Assigning ports"

# Initialize port registry if it doesn't exist
if [[ ! -f "$PORT_REGISTRY" ]]; then
  echo '{}' > "$PORT_REGISTRY"
  chmod 600 "$PORT_REGISTRY"
fi

# Read existing ports and assign new ones
PORT_INFO=$(python3 -c "
import json, sys

registry_path = '$PORT_REGISTRY'
persona_id = '$PERSONA_ID'

with open(registry_path) as f:
    registry = json.load(f)

# If persona already has ports, reuse them
if persona_id in registry:
    info = registry[persona_id]
    print(f\"{info['health']} {info['admin']}\")
    sys.exit(0)

# Find next available ports
used_health = {v['health'] for v in registry.values()}
used_admin = {v['admin'] for v in registry.values()}

health_port = 3001
while health_port in used_health:
    health_port += 1

admin_port = 3100
while admin_port in used_admin:
    admin_port += 1

print(f'{health_port} {admin_port}')
")

HEALTH_PORT=$(echo "$PORT_INFO" | awk '{print $1}')
ADMIN_PORT=$(echo "$PORT_INFO" | awk '{print $2}')

log_done "Health check port: ${HEALTH_PORT}"
log_done "Admin portal port: ${ADMIN_PORT}"

# =============================================================================
# Step 2: Create macOS user
# =============================================================================
log_step "Creating macOS user account"

if dscl . -read "/Users/${MAC_USER}" &>/dev/null; then
  log_warn "User '${MAC_USER}' already exists, skipping creation"
else
  FULL_NAME="$(echo "${PERSONA_ID}" | sed 's/./\U&/') Agent"
  sysadminctl -addUser "$MAC_USER" -fullName "$FULL_NAME" -password "$MACOS_PASSWORD" -admin 2>&1 | grep -v "^$" || true
  log_done "Created user '${MAC_USER}' (password: ${MACOS_PASSWORD})"
fi

# Ensure home directory exists
if [[ ! -d "$USER_HOME" ]]; then
  createhomedir -c -u "$MAC_USER" 2>/dev/null || true
fi

# =============================================================================
# Step 3: Clone or update repo
# =============================================================================
log_step "Setting up repository"

sudo -u "$MAC_USER" mkdir -p "${USER_HOME}/Code"

if [[ -d "$PROJECT_DIR/.git" ]]; then
  log_warn "Repo already exists, pulling latest..."
  sudo -u "$MAC_USER" git -C "$PROJECT_DIR" pull --ff-only 2>&1 || log_warn "Git pull failed (may need manual resolution)"
  log_done "Repository updated"
else
  log_info "Cloning repository..."
  sudo -u "$MAC_USER" git clone "$REPO_URL" "$PROJECT_DIR" 2>&1
  log_done "Repository cloned to ${PROJECT_DIR}"
fi

# =============================================================================
# Step 4: Install dependencies and build
# =============================================================================
log_step "Installing dependencies"

# npm install
sudo -u "$MAC_USER" bash -c "cd '$PROJECT_DIR' && npm install --production=false 2>&1" | tail -1
log_done "npm dependencies installed"

# Build native Swift helper
log_info "Building native Swift helper..."
if [[ -d "${PROJECT_DIR}/native/messages-helper" ]]; then
  sudo -u "$MAC_USER" bash -c "cd '${PROJECT_DIR}/native/messages-helper' && swift build -c release 2>&1" | tail -3
  log_done "Native Swift helper built"
else
  log_warn "Native helper directory not found, skipping (will use AppleScript transport)"
fi

# Build TypeScript + admin portal
log_info "Building TypeScript and admin portal..."
sudo -u "$MAC_USER" bash -c "cd '$PROJECT_DIR' && npm run admin:build 2>&1" | tail -3
log_done "TypeScript and admin portal built"

# =============================================================================
# Step 5: Generate config.yaml
# =============================================================================
log_step "Generating config.yaml"

cat > "${PROJECT_DIR}/config.yaml" << YAML
edge:
  agent_id: "${MAC_USER}"
  user_phone: "${PHONE}"
  persona_id: "${PERSONA_ID}"

backend:
  url: "${BACKEND_URL}"
  websocket_url: "${WEBSOCKET_URL}"
  sync_interval_seconds: 30

websocket:
  enabled: true
  reconnect_attempts: 10
  ping_interval_seconds: 30

imessage:
  poll_interval_seconds: 2
  db_path: "${USER_HOME}/Library/Messages/chat.db"
  attachments_path: "${USER_HOME}/Library/Messages/Attachments"
  transport_mode: "native_helper"
  bridge_executable: "./native/messages-helper/.build/release/messages-helper"
  bridge_args: []

database:
  path: "./edge-agent.db"
  state_path: "./data/edge-state.db"

scheduler:
  adaptive_mode: true
  check_interval_seconds: 30

logging:
  level: "info"
  file: "./edge-agent.log"

monitoring:
  sentry:
    enabled: false
  amplitude:
    enabled: true
    api_key: "\${AMPLITUDE_API_KEY}"
    flush_interval_ms: 10000
  health_check:
    enabled: true
    port: ${HEALTH_PORT}

security:
  keychain_service: "com.archety.edge.${PERSONA_ID}"
  keychain_account: "edge-state"
YAML

chown "$MAC_USER:staff" "${PROJECT_DIR}/config.yaml"
log_done "config.yaml generated"

# =============================================================================
# Step 6: Generate .env
# =============================================================================
log_step "Generating .env"

cat > "${PROJECT_DIR}/.env" << ENV
EDGE_SECRET=${EDGE_SECRET}
BACKEND_URL=${BACKEND_URL}
USER_PHONE=${PHONE}
ADMIN_PORT=${ADMIN_PORT}
ENV

chown "$MAC_USER:staff" "${PROJECT_DIR}/.env"
chmod 600 "${PROJECT_DIR}/.env"
log_done ".env generated"

# =============================================================================
# Step 7: Create data and logs directories
# =============================================================================
log_step "Creating directories"

sudo -u "$MAC_USER" mkdir -p "${PROJECT_DIR}/data"
sudo -u "$MAC_USER" mkdir -p "${PROJECT_DIR}/logs"
log_done "data/ and logs/ directories created"

# =============================================================================
# Step 8: Install LaunchDaemon
# =============================================================================
log_step "Installing LaunchDaemon"

PLIST_LABEL="com.archety.edge-${PERSONA_ID}"
PLIST_PATH="/Library/LaunchDaemons/${PLIST_LABEL}.plist"
ENTRY_FILE="${PROJECT_DIR}/dist/admin-portal/server/index.js"

# Stop existing service if running
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  log_warn "Stopping existing service..."
  launchctl bootout "system/${PLIST_LABEL}" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${ENTRY_FILE}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>

    <key>UserName</key>
    <string>${MAC_USER}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/logs/edge-agent.out.log</string>

    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/logs/edge-agent.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>NODE_ENV</key>
        <string>${ENVIRONMENT}</string>
        <key>HOME</key>
        <string>${USER_HOME}</string>
        <key>EDGE_SECRET</key>
        <string>${EDGE_SECRET}</string>
        <key>BACKEND_URL</key>
        <string>${BACKEND_URL}</string>
        <key>USER_PHONE</key>
        <string>${PHONE}</string>
        <key>ADMIN_PORT</key>
        <string>${ADMIN_PORT}</string>
    </dict>

    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
PLIST

chown root:wheel "$PLIST_PATH"
chmod 644 "$PLIST_PATH"
log_done "LaunchDaemon installed: ${PLIST_LABEL}"

# =============================================================================
# Step 9: Update port registry
# =============================================================================
log_step "Updating port registry"

python3 -c "
import json

registry_path = '$PORT_REGISTRY'
with open(registry_path) as f:
    registry = json.load(f)

registry['$PERSONA_ID'] = {
    'health': $HEALTH_PORT,
    'admin': $ADMIN_PORT,
    'user': '$MAC_USER',
    'phone': '$PHONE'
}

with open(registry_path, 'w') as f:
    json.dump(registry, f, indent=2)
"

chmod 600 "$PORT_REGISTRY"
log_done "Port registry updated"

# =============================================================================
# Done — Print manual steps
# =============================================================================
echo ""
echo -e "${BOLD}===== SETUP COMPLETE: ${PERSONA_ID} =====${NC}"
echo ""
echo -e "${GREEN}Automated steps completed:${NC}"
log_done "macOS user '${MAC_USER}' ready"
log_done "Repo at ${PROJECT_DIR}"
log_done "Dependencies installed and built"
log_done "config.yaml generated (health: ${HEALTH_PORT}, admin: ${ADMIN_PORT})"
log_done ".env generated"
log_done "LaunchDaemon installed: ${PLIST_LABEL}"
echo ""
echo -e "${YELLOW}${BOLD}MANUAL STEPS REQUIRED:${NC}"
echo ""
echo "  1. Log into '${MAC_USER}' via Fast User Switching (Apple menu or System Settings)"
echo "     Password: ${MACOS_PASSWORD}"
echo ""
echo "  2. Open Messages.app and sign in with the Apple ID for ${PHONE}"
echo ""
echo "  3. Send a test iMessage from another device to verify iMessage works"
echo ""
echo "  4. Grant Full Disk Access:"
echo "     System Settings -> Privacy & Security -> Full Disk Access -> add ${NODE_PATH}"
echo ""
echo "  5. Grant Automation permission (run in Terminal as ${MAC_USER}):"
echo "     osascript -e 'tell application \"Messages\" to get name'"
echo "     Click \"Allow\" on the permission prompt"
echo ""
echo "  6. Switch back to your admin account"
echo ""
echo "  7. Start the service:"
echo "     sudo launchctl load ${PLIST_PATH}"
echo ""
echo "  8. Verify:"
echo "     curl -s http://localhost:${HEALTH_PORT}/health"
echo ""
echo -e "${BLUE}View all personas: ./list-personas.sh${NC}"
echo -e "${BLUE}Remove this persona: sudo ./teardown-persona.sh --persona-id ${PERSONA_ID}${NC}"
echo ""
