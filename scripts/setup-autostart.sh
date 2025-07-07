#!/bin/bash

# Setup script for MCP auto-start on macOS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_FILE="$PROJECT_DIR/com.obsidian.mcp.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "Setting up MCP auto-start..."

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$LAUNCH_AGENTS_DIR"

# Copy plist file to LaunchAgents
cp "$PLIST_FILE" "$LAUNCH_AGENTS_DIR/"

# Load the launch agent
launchctl load "$LAUNCH_AGENTS_DIR/com.obsidian.mcp.plist"

echo "✓ Auto-start configured successfully!"
echo
echo "The MCP server will now:"
echo "- Start automatically when you log in"
echo "- Restart if it crashes"
echo "- Monitor and restart Tailscale funnel if needed"
echo
echo "To manage the service:"
echo "  Start:   launchctl start com.obsidian.mcp"
echo "  Stop:    launchctl stop com.obsidian.mcp"
echo "  Disable: launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.plist"
echo "  Enable:  launchctl load ~/Library/LaunchAgents/com.obsidian.mcp.plist"
echo
echo "To check status:"
echo "  ./scripts/monitor-mcp.sh status"