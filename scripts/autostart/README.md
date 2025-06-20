# Auto-Start Setup for Obsidian MCP Server

This directory contains scripts and templates to automatically start your Obsidian MCP Server and Tailscale Funnel on system boot, providing seamless Claude.ai integration without manual intervention.

## 🎯 What This Does

The auto-start setup configures your system to:

- **Automatically start the MCP server** in HTTP mode on boot
- **Automatically start Tailscale Funnel** on port 3010 for remote access
- **Restart services automatically** if they crash or fail
- **Log all activity** to the project's logs directory
- **Run in the background** without user interaction required

## 📋 Prerequisites

Before installing auto-start, ensure you have:

1. **Obsidian** installed and running
2. **Obsidian Local REST API plugin** installed and configured with an API key
3. **Tailscale** installed and authenticated (`tailscale login`)
4. **Tailscale Funnel** enabled for your account
5. **Node.js** (v18+) and **npm** installed
6. **Project built** (run `npm run build` in the project root)

## 🚀 Quick Install (macOS)

```bash
# Navigate to your project directory
cd /path/to/obsidian-mcp-server-enhanced

# Run the installation script
./scripts/autostart/macos/install-autostart-macos.sh
```

The script will:
1. Check prerequisites
2. Prompt for your Obsidian API key
3. Create a `.env` configuration file
4. Install and start the LaunchAgent services
5. Verify everything is running

## 📁 What Gets Installed

### LaunchAgent Services (macOS)

Two background services are installed to `~/Library/LaunchAgents/`:

#### 1. `com.obsidian.mcp.server.plist`
- **Purpose**: Runs the MCP server
- **Configuration**: HTTP transport, debug logging
- **Auto-restart**: Yes (KeepAlive enabled)
- **Logs**: `{project}/logs/launchd.out.log` and `launchd.err.log`

#### 2. `com.obsidian.mcp.tailscale.plist`
- **Purpose**: Runs Tailscale Funnel on port 3010
- **Auto-restart**: Yes (every 5 seconds to ensure connection)
- **Logs**: `{project}/logs/tailscale.out.log` and `tailscale.err.log`

### Configuration Files

#### `.env` file (created in project root)
```bash
OBSIDIAN_API_KEY=your_actual_api_key
MCP_TRANSPORT_TYPE=http
```

## 🔍 Verification

After installation, verify everything is working:

### Check Service Status
```bash
# List all LaunchAgent services
launchctl list | grep obsidian

# Check Tailscale Funnel status
tailscale funnel status
```

### Check Logs
```bash
# View MCP server logs
tail -f logs/launchd.out.log

# View Tailscale logs  
tail -f logs/tailscale.out.log

# View combined application logs
tail -f logs/combined.log
```

### Test the Server
```bash
# Test local HTTP endpoint
curl http://localhost:3010/mcp

# Check your Tailscale Funnel URL
curl https://your-machine-name.tail123abc.ts.net/mcp
```

## 🌐 Claude.ai Integration

Once auto-start is configured, add your server to Claude.ai:

1. **Get your Tailscale Funnel URL:**
   ```bash
   tailscale funnel status
   ```

2. **Add to Claude.ai Remote MCP servers:**
   ```json
   {
     "url": "https://your-machine-name.tail123abc.ts.net/mcp?api_key=your_obsidian_api_key",
     "name": "Obsidian Vault"
   }
   ```

3. **Test the connection** in Claude.ai by asking it to list your Obsidian files

## 🛠️ Management Commands

### Restart Services
```bash
# Restart MCP server
launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.server.plist
launchctl load ~/Library/LaunchAgents/com.obsidian.mcp.server.plist

# Restart Tailscale Funnel
launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist
launchctl load ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist
```

### View Service Status
```bash
# Check if services are loaded
launchctl list | grep com.obsidian.mcp

# View detailed service info
launchctl print gui/$UID/com.obsidian.mcp.server
```

### Stop Services (without uninstalling)
```bash
launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.server.plist
launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist
```

## 🗑️ Uninstall

To completely remove auto-start:

```bash
# Run the uninstall script
./scripts/autostart/macos/uninstall-autostart-macos.sh
```

This removes the LaunchAgent services but keeps:
- Your project files and configuration
- Node.js and Tailscale installations
- Log files for troubleshooting

## 🐛 Troubleshooting

### MCP Server Won't Start
1. **Check the logs:**
   ```bash
   cat logs/launchd.err.log
   ```

2. **Common issues:**
   - Missing or invalid `OBSIDIAN_API_KEY` in `.env`
   - Obsidian Local REST API plugin not running
   - Port 3010 already in use
   - Node.js path incorrect (check `/usr/local/bin/node` exists)

### Tailscale Funnel Issues
1. **Check Tailscale status:**
   ```bash
   tailscale status
   tailscale funnel status
   ```

2. **Common issues:**
   - Not logged into Tailscale (`tailscale login`)
   - Funnel not enabled for account
   - Port 3010 not accessible

### Network Connectivity
1. **Test local connection:**
   ```bash
   curl -v http://localhost:3010/mcp?api_key=your_key
   ```

2. **Test Tailscale connection:**
   ```bash
   curl -v https://your-funnel-url/mcp?api_key=your_key
   ```

### Permission Issues
If you get permission errors:
```bash
# Fix script permissions
chmod +x scripts/autostart/macos/*.sh

# Fix service file permissions
chmod 644 ~/Library/LaunchAgents/com.obsidian.mcp.*.plist
```

## 📊 Monitoring

### Log Rotation
The services log to the project's `logs/` directory. Consider setting up log rotation for production use:

```bash
# Add to crontab for weekly log rotation
0 0 * * 0 /usr/sbin/newsyslog -f /path/to/your/newsyslog.conf
```

### Health Checks
Create a simple health check script:

```bash
#!/bin/bash
# health-check.sh
if curl -s http://localhost:3010/mcp > /dev/null; then
    echo "✅ MCP Server healthy"
else
    echo "❌ MCP Server down"
fi
```

## 🔧 Customization

### Environment Variables
Edit `.env` to customize behavior:

```bash
# Log level (debug, info, warn, error)
MCP_LOG_LEVEL=info

# Cache settings
OBSIDIAN_ENABLE_CACHE=true
OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN=10

# HTTP server settings
MCP_HTTP_PORT=3010
MCP_HTTP_HOST=127.0.0.1
```

### Service Configuration
The LaunchAgent plist files can be customized after installation. After editing, reload the service:

```bash
launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.server.plist
launchctl load ~/Library/LaunchAgents/com.obsidian.mcp.server.plist
```

## 🔐 Security Notes

- **API Key Storage**: Your Obsidian API key is stored in the `.env` file and should be kept secure
- **Network Access**: Tailscale Funnel exposes your server to the internet securely through Tailscale's mesh network
- **Log Files**: Service logs may contain sensitive information; ensure proper file permissions
- **Access Control**: Consider using Tailscale ACLs for additional access restrictions

## 🆘 Support

If you encounter issues:

1. **Check the logs** in the `logs/` directory
2. **Review the troubleshooting section** above
3. **Test prerequisites** manually
4. **Open an issue** on GitHub with log outputs and system information

For more information about the Obsidian MCP Server, see the main [README.md](../../README.md).