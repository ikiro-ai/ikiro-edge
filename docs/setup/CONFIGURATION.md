# Configuration Guide

Complete guide to configuring the edge relay for optimal performance.

## Configuration Files

- **`config.yaml`** - Runtime configuration
- **`.env`** - Secrets and credentials

## config.yaml

### Basic Configuration

```yaml
edge:
  agent_id: "edge_1234567890"  # Auto-generated from phone
  user_phone: "+1234567890"    # Your phone number (REQUIRED)

backend:
  url: "https://archety-backend.onrender.com"
  sync_interval_seconds: 60

imessage:
  poll_interval_seconds: 2
  db_path: "~/Library/Messages/chat.db"

database:
  path: "./data/scheduler.db"

logging:
  level: "info"  # debug, info, warn, error
  file: "./edge-agent.log"
```

### Performance Tuning

The edge relay includes performance optimization profiles:

```yaml
performance:
  profile: "balanced"  # Options: balanced, low-latency, low-resource
```

#### Balanced Profile (Default)
Best for most use cases:
- Poll interval: 2 seconds
- Sync interval: 60 seconds
- Max concurrent requests: 3
- Request timeout: 10 seconds

#### Low-Latency Profile
For fastest response times:
- Poll interval: 1 second (faster message detection)
- Sync interval: 30 seconds (more frequent syncs)
- Max concurrent requests: 5
- Request timeout: 8 seconds

**Trade-off:** Higher CPU usage (~10% vs ~5%)

#### Low-Resource Profile
For minimal CPU/battery usage:
- Poll interval: 5 seconds
- Sync interval: 120 seconds
- Max concurrent requests: 2
- Request timeout: 15 seconds

**Trade-off:** Slower message detection (up to 5s delay)

### Advanced Configuration

Override specific performance settings:

```yaml
backend:
  url: "https://archety-backend.onrender.com"
  sync_interval_seconds: 60
  request_timeout_ms: 10000  # HTTP request timeout
  max_concurrent_requests: 3  # Parallel backend calls

imessage:
  poll_interval_seconds: 2
  db_path: "~/Library/Messages/chat.db"
  enable_fast_check: true  # Pre-check before expensive queries
  max_messages_per_poll: 100  # Max messages to process per poll

database:
  path: "./data/scheduler.db"

scheduler:
  check_interval_seconds: 30  # How often to check for scheduled messages
  adaptive_polling: false  # Future: check based on next scheduled time

performance:
  profile: "balanced"
  parallel_message_processing: true  # Process multiple messages concurrently
  batch_applescript_sends: true  # Send multiple bubbles in one AppleScript

logging:
  level: "info"  # debug (verbose), info (normal), warn (errors only), error (critical)
  file: "./edge-agent.log"
```

## Environment Variables (.env)

Required secrets and credentials:

```env
# Backend authentication (REQUIRED)
EDGE_SECRET=your_shared_secret_from_backend_team
REGISTRATION_TOKEN=your_registration_token

# Optional overrides
# BACKEND_URL=https://archety-backend.onrender.com
# USER_PHONE=+1234567890
```

## Performance Comparison

| Metric | Low-Resource | Balanced | Low-Latency |
|--------|-------------|----------|-------------|
| Message detection delay | 0-5s | 0-2s | 0-1s |
| CPU usage (idle) | ~3% | ~5% | ~10% |
| Backend sync frequency | Every 2min | Every 1min | Every 30s |
| Concurrent processing | 2 messages | 3 messages | 5 messages |

## Monitoring Performance

Watch logs to see active optimizations:

```bash
./edge-agent.sh logs -f

# Look for these indicators:
⚡ Sending REFLEX message        # Fast reflex path active
📤 Sending 3 bubbles (batched)   # Batch optimization active
📬 Processing 5 new message(s)   # Parallel processing
✅ Reflex message sent immediately
```

## Configuration Best Practices

### For Development
```yaml
performance:
  profile: "low-latency"

logging:
  level: "debug"
```

### For Production (Mac Mini)
```yaml
performance:
  profile: "balanced"

logging:
  level: "info"
```

### For Battery-Powered Mac
```yaml
performance:
  profile: "low-resource"

logging:
  level: "warn"
```

## Auto-Start on Boot

For production auto-start, use `setup-persona.sh` which provisions a user-domain LaunchAgent per persona. See the [Multi-Persona Setup Guide](./MULTI_PERSONA_EDGE_SETUP.md) for details.

For development, use `./edge-agent.sh start` to run manually.

## Logging Configuration

### Log Levels

- **debug**: Very verbose, shows all operations
- **info**: Normal operation, key events
- **warn**: Warnings and errors only
- **error**: Critical errors only

### Log Locations

- **Console output**: When running `npm start` directly
- **File**: `./edge-agent.log` (when using edge-agent.sh)
- **LaunchAgent**: `./logs/edge-relay.log` and `./logs/edge-relay-error.log`

### Viewing Logs

```bash
# Real-time tail
./edge-agent.sh logs -f

# Last 50 lines
./edge-agent.sh logs

# Raw log file
tail -f edge-agent.log

# Filter for errors
grep "ERROR" edge-agent.log

# Filter for specific thread
grep "thread_id" edge-agent.log
```

## Validating Configuration

Check your configuration is valid:

```bash
# Build (validates TypeScript)
npm run build

# Test configuration loading
npm start
# Should show: "Edge Agent initialized with scheduler"
# Press Ctrl+C to stop

# Check config is loaded
./edge-agent.sh status
```

## See Also

- [Getting Started](./GETTING_STARTED.md) - Initial setup
- [Performance Optimizations](../architecture/PERFORMANCE.md) - Understanding optimizations
- [Troubleshooting](./TROUBLESHOOTING.md) - Common issues
