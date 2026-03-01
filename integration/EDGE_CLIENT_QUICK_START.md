# Edge Client Quick Start - Critical Changes

**⚠️ BREAKING CHANGES - Action Required**
**Date:** November 14, 2025

---

## 🚨 CRITICAL: HMAC Authentication Required

**Edge clients must send HMAC bearer tokens (not raw EDGE_SECRET).**

```typescript
import crypto from 'crypto';

function generateEdgeBearerToken(edgeSecret: string, edgeAgentId: string, userPhone: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const tokenData = `${edgeAgentId}:${userPhone}:${timestamp}`;
  const signature = crypto.createHmac('sha256', edgeSecret).update(tokenData).digest('hex');
  return Buffer.from(`${tokenData}:${signature}`).toString('base64');
}

const token = generateEdgeBearerToken(process.env.EDGE_SECRET!, process.env.EDGE_AGENT_ID!, process.env.USER_PHONE!);

await axios.post(
  `${backendUrl}/edge/message`,
  payload,
  {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Edge-Agent-Id': process.env.EDGE_AGENT_ID,
      'Content-Type': 'application/json'
    }
  }
);
```

**Environment Variable:**
```bash
# Add to .env
EDGE_SECRET="your-shared-secret-here"
EDGE_AGENT_ID="edge_13107404018"
USER_PHONE="+13107404018"

# Generate secret (32 bytes hex):
openssl rand -hex 32
```

**⚠️ You will get `401 Unauthorized` without this!**

---

## 📋 3-Minute Implementation Checklist

### Step 1: Add Secret to Environment
```bash
# Generate a secret
SECRET=$(openssl rand -hex 32)
echo "EDGE_SECRET=$SECRET" >> .env

# Send this secret to backend engineer to configure on Railway
echo "Backend engineer: Add this to Railway environment variables:"
echo "EDGE_SECRET=$SECRET"
```

### Step 2: Update Your HTTP Client (HMAC token)
```typescript
import axios from 'axios';
import crypto from 'crypto';

function makeToken(secret: string, edgeAgentId: string, userPhone: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const data = `${edgeAgentId}:${userPhone}:${ts}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return Buffer.from(`${data}:${sig}`).toString('base64');
}

const token = makeToken(process.env.EDGE_SECRET!, process.env.EDGE_AGENT_ID!, process.env.USER_PHONE!);

const edgeClient = axios.create({
  baseURL: process.env.BACKEND_URL,
  headers: {
    'Authorization': `Bearer ${token}`,
    'X-Edge-Agent-Id': process.env.EDGE_AGENT_ID,
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

const response = await edgeClient.post('/edge/message', payload);
```

### Step 3: Add Error Handling
```typescript
try {
  const response = await orchestratorClient.post('/orchestrator/message', payload);
  // Process response
} catch (error) {
  if (error.response?.status === 401) {
    console.error('❌ Auth failed - check EDGE_SECRET');
  } else if (error.response?.status === 429) {
    const retryAfter = error.response.headers['retry-after'] || 60;
    console.warn(`⚠️ Rate limited - retry after ${retryAfter}s`);
  }
  throw error;
}
```

### Step 4: Test It
```bash
# Test WebSocket auth quickly (uses HMAC token generator in repo)
EDGE_AGENT_ID=edge_13107404018 USER_PHONE=+13107404018 node test_websocket.js
```

**Expected:**
- ✅ `200 OK` with response → Authentication working!
- ❌ `401 Unauthorized` → Secret doesn't match backend

---

## 📖 Full Documentation

For complete details including:
- Photo processing support
- Rate limiting handling
- HMAC signature validation (required)
- Example code
- Testing instructions

See: [`EDGE_CLIENT_UPDATES_NOV_2025.md`](./EDGE_CLIENT_UPDATES_NOV_2025.md)

---

## 📞 Need Help?

- Backend Engineer: Engineer 2
- Backend Docs: https://api.ikiro.ai/docs
- Edge Spec: `/docs/edge/EDGE_AGENT_SPEC.md`

---

**Status:** 🔴 CRITICAL - Implement immediately for production
**Estimated Time:** 5-10 minutes
