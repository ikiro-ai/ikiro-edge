# Getting Started with Edge Relay

Complete guide to set up and run the Mac mini edge agent in 15 minutes.

## Prerequisites

- Mac mini (or any Mac) running macOS 12+
- Messages.app configured with Apple ID
- Admin access to install software
- Internet connection

## Quick Setup

### 1. Install Dependencies

```bash
# Install Xcode Command Line Tools (if not already installed)
xcode-select --install

# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js 18+
brew install node

# Verify installation
node --version  # Should be v18.0.0 or higher
```

### 2. Install Project Dependencies

```bash
cd /Users/sage1/Code/edge-relay
npm install
```

### 3. Configure

```bash
# Copy environment template
cp .env.example .env

# Edit with your credentials
nano .env
```

Add your credentials (get from backend team):
```env
EDGE_SECRET=your_shared_secret_here
REGISTRATION_TOKEN=your_registration_token
```

Edit `config.yaml` to set your phone number:
```yaml
edge:
  user_phone: "+1234567890"  # Your phone number
```

### 4. Grant Permissions

The edge agent needs special permissions to access Messages.

#### Full Disk Access (Required)

1. Open **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Click the **+** button
3. Navigate to `/Applications/Utilities/Terminal.app` (or iTerm if you use that)
4. Add and enable it

#### Automation (Required for Sending)

1. Open **System Settings** → **Privacy & Security** → **Automation**
2. Enable **Terminal** → **Messages**

### 5. Build and Run

```bash
# Build TypeScript
npm run build

# Start the agent
./edge-agent.sh start

# Check status
./edge-agent.sh status

# View logs
./edge-agent.sh logs
```

## Verify It's Working

1. Send yourself an iMessage from another device
2. Check the logs: `./edge-agent.sh logs -f`
3. You should see:
   ```
   📬 Processing 1 new message(s)
   Processing message from +1234567890
   ✅ Response sent successfully
   ```

## Management Commands

### Manual Mode (Development)

```bash
# Start
./edge-agent.sh start

# Stop
./edge-agent.sh stop

# Restart
./edge-agent.sh restart

# Status
./edge-agent.sh status

# View logs
./edge-agent.sh logs

# Live tail logs
./edge-agent.sh logs -f
```

### Auto-Start on Boot (Production)

For production use, provision personas with `setup-persona.sh` which installs a user-domain LaunchAgent with auto-start and crash recovery:

```bash
sudo ./setup-persona.sh \
  --persona-id luna \
  --phone "+12137288322" \
  --edge-secret "your_shared_secret"

# Restart a persona
launchctl kickstart -k gui/$(id -u)/com.archety.edge-luna

# View all personas and their status
./list-personas.sh
```

**See [Multi-Persona Setup Guide](./MULTI_PERSONA_EDGE_SETUP.md) for complete setup and troubleshooting.**

## Optional: SSH Access

If running headless, add these aliases to `~/.zshrc`:

```bash
alias edge-start='cd ~/code/edge-relay && ./edge-agent.sh start'
alias edge-stop='cd ~/code/edge-relay && ./edge-agent.sh stop'
alias edge-restart='cd ~/code/edge-relay && ./edge-agent.sh restart'
alias edge-status='cd ~/code/edge-relay && ./edge-agent.sh status'
alias edge-logs='cd ~/code/edge-relay && ./edge-agent.sh logs -f'
```

Then: `source ~/.zshrc`

## Troubleshooting

### "Cannot read Messages database"

**Solution:** Grant Full Disk Access to Terminal (see step 4 above)

### "AppleScript error"

**Solution:** Grant Automation permission (see step 4 above)

### "Backend returns 401 Unauthorized"

**Solution:** Check your `EDGE_SECRET` in `.env` matches the backend

### Messages.app not working

**Solution:** Make sure Messages.app is running and signed in with your Apple ID

## Next Steps

- See [Auto-Start Guide](./AUTO_START.md) to run as system service
- See [Configuration Guide](./CONFIGURATION.md) for performance tuning
- See [Architecture Overview](../architecture/OVERVIEW.md) to understand how it works
- See [Troubleshooting Guide](./TROUBLESHOOTING.md) for common issues

## Support

- Check logs: `./edge-agent.sh logs`
- Review configuration: `cat config.yaml`
- See [Troubleshooting Guide](./TROUBLESHOOTING.md) for common issues
