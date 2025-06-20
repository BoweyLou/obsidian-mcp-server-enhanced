#!/bin/bash

# Obsidian MCP Server - macOS Auto-Start Uninstallation Script
# This script removes the automatic startup services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🗑️  Obsidian MCP Server - Auto-Start Removal${NC}"
echo "=============================================="
echo ""

echo -e "${BLUE}Stopping and removing services...${NC}"

# Unload and remove MCP server service
if [ -f ~/Library/LaunchAgents/com.obsidian.mcp.server.plist ]; then
    launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.server.plist 2>/dev/null || true
    rm ~/Library/LaunchAgents/com.obsidian.mcp.server.plist
    echo -e "${GREEN}✅ Removed MCP Server service${NC}"
else
    echo -e "${YELLOW}⚠️  MCP Server service not found${NC}"
fi

# Unload and remove Tailscale Funnel service
if [ -f ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist ]; then
    launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist 2>/dev/null || true
    rm ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist
    echo -e "${GREEN}✅ Removed Tailscale Funnel service${NC}"
else
    echo -e "${YELLOW}⚠️  Tailscale Funnel service not found${NC}"
fi

echo ""
echo -e "${GREEN}🎉 Auto-start services removed successfully!${NC}"
echo ""
echo "Note: This script does not remove:"
echo "• The project files or .env configuration"
echo "• Node.js or Tailscale installations"
echo "• Log files in the logs/ directory"
echo ""
echo "The MCP server will no longer start automatically on boot."