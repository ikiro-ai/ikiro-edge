#!/usr/bin/env bash
# Verify multi-persona edge setup after running setup-persona.sh
# Usage:
#   sudo ./verify-persona-setup.sh --persona-id luna --phone +12137288322 [--backend-url https://api.ikiro.ai]

set -euo pipefail

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

PERSONA_ID=""
PHONE=""
BACKEND_URL="https://api.ikiro.ai"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --persona-id) PERSONA_ID="$2"; shift 2 ;;
    --phone) PHONE="$2"; shift 2 ;;
    --backend-url) BACKEND_URL="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: sudo $0 --persona-id <id> --phone <E.164> [--backend-url <url>]"
      exit 0
      ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$PERSONA_ID" || -z "$PHONE" ]]; then
  log_error "--persona-id and --phone are required"
  exit 1
fi

MAC_USER="${PERSONA_ID}1"
PROJECT_DIR="/Users/${MAC_USER}/Code/archety-edge"
PLIST_LABEL="com.archety.edge-${PERSONA_ID}"
PLIST_PATH="/Library/LaunchDaemons/${PLIST_LABEL}.plist"

CHECKS_PASSED=0
CHECKS_FAILED=0

check_ok() {
  local msg="$1"
  log_info "✅ ${msg}"
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
}

check_fail() {
  local msg="$1"
  log_error "❌ ${msg}"
  CHECKS_FAILED=$((CHECKS_FAILED + 1))
}

check_warn() {
  local msg="$1"
  log_warn "⚠️  ${msg}"
}

require_file() {
  local file="$1"
  local label="$2"
  if [[ -f "$file" ]]; then
    check_ok "${label}: ${file}"
  else
    check_fail "${label} missing: ${file}"
  fi
}

log_step "Identity + filesystem"
if dscl . -read "/Users/${MAC_USER}" >/dev/null 2>&1; then
  check_ok "macOS user exists: ${MAC_USER}"
else
  check_fail "macOS user missing: ${MAC_USER}"
fi

require_file "${PROJECT_DIR}/config.yaml" "config.yaml"
require_file "${PROJECT_DIR}/.env" ".env"
require_file "${PLIST_PATH}" "LaunchDaemon plist"

log_step "Config sanity"
if [[ -f "${PROJECT_DIR}/config.yaml" ]]; then
  AGENT_ID=$(grep -E '^[[:space:]]*agent_id:' "${PROJECT_DIR}/config.yaml" | sed -E 's/.*"([^"]+)".*/\1/' || true)
  USER_PHONE_CFG=$(grep -E '^[[:space:]]*user_phone:' "${PROJECT_DIR}/config.yaml" | sed -E 's/.*"([^"]+)".*/\1/' || true)
  PERSONA_CFG=$(grep -E '^[[:space:]]*persona_id:' "${PROJECT_DIR}/config.yaml" | sed -E 's/.*"([^"]+)".*/\1/' || true)
  HEALTH_PORT=$(grep -E '^[[:space:]]*port:' "${PROJECT_DIR}/config.yaml" | tail -1 | sed -E 's/.*port:[[:space:]]*([0-9]+).*/\1/' || true)

  [[ "$AGENT_ID" == "$MAC_USER" ]] && check_ok "config edge.agent_id=${AGENT_ID}" || check_fail "config edge.agent_id mismatch (got '${AGENT_ID}', expected '${MAC_USER}')"
  [[ "$USER_PHONE_CFG" == "$PHONE" ]] && check_ok "config edge.user_phone=${USER_PHONE_CFG}" || check_fail "config edge.user_phone mismatch (got '${USER_PHONE_CFG}', expected '${PHONE}')"
  [[ "$PERSONA_CFG" == "$PERSONA_ID" ]] && check_ok "config edge.persona_id=${PERSONA_CFG}" || check_fail "config edge.persona_id mismatch (got '${PERSONA_CFG}', expected '${PERSONA_ID}')"
  [[ -n "$HEALTH_PORT" ]] && check_ok "health port parsed from config: ${HEALTH_PORT}" || check_fail "could not parse health port from config.yaml"
fi

log_step "Environment + auth vars"
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  grep -q '^EDGE_SECRET=' "${PROJECT_DIR}/.env" && check_ok ".env has EDGE_SECRET" || check_fail ".env missing EDGE_SECRET"
  grep -q '^USER_PHONE=' "${PROJECT_DIR}/.env" && check_ok ".env has USER_PHONE" || check_fail ".env missing USER_PHONE"
  grep -q '^EDGE_AGENT_ID=' "${PROJECT_DIR}/.env" && check_ok ".env has EDGE_AGENT_ID" || check_fail ".env missing EDGE_AGENT_ID"
fi

log_step "LaunchDaemon state"
if launchctl print "system/${PLIST_LABEL}" >/tmp/${PLIST_LABEL}.print 2>/dev/null; then
  check_ok "launchd service exists in system domain: ${PLIST_LABEL}"
  if grep -q 'state = running' /tmp/${PLIST_LABEL}.print; then
    check_ok "service state is running"
  else
    check_fail "service is not running"
  fi
else
  check_fail "launchd service not loaded: system/${PLIST_LABEL}"
fi

log_step "Health endpoint"
if [[ -n "${HEALTH_PORT:-}" ]]; then
  HTTP_CODE=$(curl -s -o /tmp/${PLIST_LABEL}.health -w "%{http_code}" "http://127.0.0.1:${HEALTH_PORT}/health" || true)
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_ok "health endpoint reachable on :${HEALTH_PORT}"
  else
    check_fail "health endpoint failed on :${HEALTH_PORT} (HTTP ${HTTP_CODE})"
  fi
fi

log_step "HMAC WebSocket auth smoke test"
if [[ -f "${PROJECT_DIR}/test_websocket.js" ]]; then
  if sudo -u "$MAC_USER" bash -lc "cd '${PROJECT_DIR}' && EDGE_AGENT_ID='${MAC_USER}' USER_PHONE='${PHONE}' BACKEND_URL='${BACKEND_URL}' node test_websocket.js" >/tmp/${PLIST_LABEL}.ws 2>&1; then
    check_ok "websocket auth test passed"
  else
    if grep -q 'connected successfully' /tmp/${PLIST_LABEL}.ws; then
      check_ok "websocket connected (from output parse)"
    else
      check_fail "websocket auth test failed (see /tmp/${PLIST_LABEL}.ws)"
    fi
  fi
else
  check_fail "test_websocket.js not found"
fi

log_step "Recent logs quick scan"
ERR_LOG="${PROJECT_DIR}/logs/edge-agent.err.log"
OUT_LOG="${PROJECT_DIR}/logs/edge-agent.out.log"
if [[ -f "$ERR_LOG" ]]; then
  if tail -n 200 "$ERR_LOG" | grep -Eqi 'invalid token|403|Unauthorized|permission denied'; then
    check_warn "recent err log contains auth/permission warnings (review: ${ERR_LOG})"
  else
    check_ok "no obvious auth/permission errors in recent err log"
  fi
else
  check_warn "err log missing: ${ERR_LOG}"
fi

if [[ -f "$OUT_LOG" ]]; then
  if tail -n 200 "$OUT_LOG" | grep -Eqi 'WebSocket connected|Token verified|connected via WebSocket'; then
    check_ok "recent out log shows websocket activity"
  else
    check_warn "no recent websocket success lines found in out log"
  fi
else
  check_warn "out log missing: ${OUT_LOG}"
fi

echo ""
echo -e "${BOLD}Verification summary:${NC} passed=${CHECKS_PASSED}, failed=${CHECKS_FAILED}"

if [[ $CHECKS_FAILED -gt 0 ]]; then
  exit 1
fi
