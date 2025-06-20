#!/bin/bash

# Obsidian MCP Server - macOS Auto-Start Installation Script
# This script sets up automatic startup of the MCP server and Tailscale Funnel on boot

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the absolute path of the project directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo -e "${BLUE}🚀 Obsidian MCP Server - Auto-Start Setup${NC}"
echo "=================================================="
echo "Project directory: $PROJECT_DIR"
echo ""

# Check prerequisites
echo -e "${BLUE}Checking prerequisites...${NC}"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found. Please install Node.js first.${NC}"
    exit 1
fi

# Check if Tailscale is installed
if ! command -v tailscale &> /dev/null; then
    echo -e "${RED}❌ Tailscale not found. Please install Tailscale first.${NC}"
    echo "   Download from: https://tailscale.com/download/mac"
    exit 1
fi

# Check if project is built
if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
    echo -e "${YELLOW}⚠️  Project not built. Building now...${NC}"
    cd "$PROJECT_DIR"
    npm install
    npm run build
fi

echo -e "${GREEN}✅ Prerequisites check passed${NC}"
echo ""

# Get Obsidian API Key
echo -e "${BLUE}Configuration Setup${NC}"
echo "==================="

if [ -f "$PROJECT_DIR/.env" ]; then
    echo -e "${YELLOW}⚠️  Existing .env file found.${NC}"
    read -p "Do you want to overwrite it? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing .env file..."
        ENV_EXISTS=true
    fi
fi

if [ "$ENV_EXISTS" != "true" ]; then
    echo "Please provide your Obsidian Local REST API plugin API key."
    echo "You can find this in Obsidian → Settings → Community Plugins → Local REST API → API Key"
    echo ""
    read -p "Obsidian API Key: " -r OBSIDIAN_API_KEY
    
    if [ -z "$OBSIDIAN_API_KEY" ]; then
        echo -e "${RED}❌ API key is required. Exiting.${NC}"
        exit 1
    fi
    
    # Create .env file
    cp "$SCRIPT_DIR/.env.template" "$PROJECT_DIR/.env"
    sed -i '' "s/your_obsidian_api_key_here/$OBSIDIAN_API_KEY/g" "$PROJECT_DIR/.env"
    echo -e "${GREEN}✅ Created .env file${NC}"
fi

echo ""

# Create LaunchAgent directory if it doesn't exist
mkdir -p ~/Library/LaunchAgents

# Generate and install MCP server plist
echo -e "${BLUE}Installing LaunchAgent services...${NC}"

# MCP Server service
cp "$SCRIPT_DIR/obsidian-mcp-server.plist.template" ~/Library/LaunchAgents/com.obsidian.mcp.server.plist
sed -i '' "s|{{PROJECT_PATH}}|$PROJECT_DIR|g" ~/Library/LaunchAgents/com.obsidian.mcp.server.plist

# Tailscale Funnel service  
cp "$SCRIPT_DIR/obsidian-mcp-tailscale.plist.template" ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist
sed -i '' "s|{{PROJECT_PATH}}|$PROJECT_DIR|g" ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist

echo -e "${GREEN}✅ LaunchAgent files installed${NC}"

# Load the services
echo -e "${BLUE}Starting services...${NC}"

# Unload if already loaded (in case of reinstall)
launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.server.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist 2>/dev/null || true

# Load the services
launchctl load ~/Library/LaunchAgents/com.obsidian.mcp.server.plist
launchctl load ~/Library/LaunchAgents/com.obsidian.mcp.tailscale.plist

echo -e "${GREEN}✅ Services started${NC}"
echo ""

# Wait a moment for services to start
sleep 3

# Check if services are running
echo -e "${BLUE}Checking service status...${NC}"

MCP_STATUS=$(launchctl list | grep com.obsidian.mcp.server || echo "not found")
TAILSCALE_STATUS=$(launchctl list | grep com.obsidian.mcp.tailscale || echo "not found")

if [[ $MCP_STATUS != *"not found"* ]]; then
    echo -e "${GREEN}✅ MCP Server service is running${NC}"
else
    echo -e "${RED}❌ MCP Server service failed to start${NC}"
fi

if [[ $TAILSCALE_STATUS != *"not found"* ]]; then
    echo -e "${GREEN}✅ Tailscale Funnel service is running${NC}"
else
    echo -e "${RED}❌ Tailscale Funnel service failed to start${NC}"
fi

echo ""
echo -e "${GREEN}🎉 Auto-start setup complete!${NC}"
echo ""
echo "Your Obsidian MCP Server will now:"
echo "• Start automatically on boot"
echo "• Run on HTTP transport (port 3010)"
echo "• Expose via Tailscale Funnel for Claude.ai access"
echo "• Restart automatically if it crashes"
echo ""
echo "Next steps:"
echo "1. Check your Tailscale Funnel URL: tailscale funnel status"
echo "2. Add the URL to Claude.ai Remote MCP servers"
echo "3. Check logs in: $PROJECT_DIR/logs/"
echo ""
echo "To uninstall:"
echo "  ./scripts/autostart/macos/uninstall-autostart-macos.sh"