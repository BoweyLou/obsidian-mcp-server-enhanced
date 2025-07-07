#!/bin/bash

# Obsidian MCP Server Health Check Script
# This script verifies all components are running correctly

echo "🔍 Obsidian MCP Server Health Check"
echo "==================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Load environment variables
source .env 2>/dev/null || echo -e "${YELLOW}Warning: .env file not found${NC}"

# 1. Check MCP Server Process
echo "1. Checking MCP Server..."
if ps aux | grep "node.*dist/index.js" | grep -v grep > /dev/null; then
    PID=$(ps aux | grep "node.*dist/index.js" | grep -v grep | awk '{print $2}')
    echo -e "   ${GREEN}✓ MCP Server is running (PID: $PID)${NC}"
else
    echo -e "   ${RED}✗ MCP Server is NOT running${NC}"
    echo "   Run: npm run start:http"
fi

# 2. Check Local HTTP Endpoint
echo ""
echo "2. Checking Local HTTP Endpoint..."
if curl -s -f http://127.0.0.1:3010/mcp > /dev/null 2>&1; then
    echo -e "   ${GREEN}✓ Local endpoint is responding${NC}"
else
    echo -e "   ${RED}✗ Local endpoint is NOT responding${NC}"
fi

# 3. Check Obsidian API
echo ""
echo "3. Checking Obsidian REST API..."
if curl -s -f -H "Authorization: Bearer ${OBSIDIAN_API_KEY}" http://127.0.0.1:27123/vault/ > /dev/null 2>&1; then
    echo -e "   ${GREEN}✓ Obsidian API is accessible${NC}"
else
    echo -e "   ${RED}✗ Obsidian API is NOT accessible${NC}"
    echo "   Check: Is Obsidian running? Is Local REST API plugin enabled?"
fi

# 4. Check Tailscale Status
echo ""
echo "4. Checking Tailscale..."
if tailscale status > /dev/null 2>&1; then
    echo -e "   ${GREEN}✓ Tailscale is running${NC}"
    
    # Get device name
    DEVICE_NAME=$(tailscale status --self --json | grep -o '"DNSName":"[^"]*' | cut -d'"' -f4 | sed 's/\.$//')
    echo "   Device: $DEVICE_NAME"
else
    echo -e "   ${RED}✗ Tailscale is NOT running${NC}"
fi

# 5. Check Tailscale Funnel
echo ""
echo "5. Checking Tailscale Funnel..."
if ps aux | grep -E "tailscale.*funnel.*3010" | grep -v grep > /dev/null; then
    echo -e "   ${GREEN}✓ Tailscale funnel is running${NC}"
    
    # Test funnel endpoint
    if [ ! -z "$DEVICE_NAME" ]; then
        FUNNEL_URL="https://${DEVICE_NAME}/mcp"
        if curl -s -f "$FUNNEL_URL" > /dev/null 2>&1; then
            echo -e "   ${GREEN}✓ Funnel endpoint is accessible${NC}"
            echo ""
            echo -e "   ${GREEN}🎉 Your Claude.ai Remote MCP URL:${NC}"
            echo "   $FUNNEL_URL?api_key=$OBSIDIAN_API_KEY"
        else
            echo -e "   ${YELLOW}⚠ Funnel endpoint returned an error (this might be normal)${NC}"
            echo ""
            echo "   Your Claude.ai Remote MCP URL should be:"
            echo "   $FUNNEL_URL?api_key=$OBSIDIAN_API_KEY"
        fi
    fi
else
    echo -e "   ${RED}✗ Tailscale funnel is NOT running${NC}"
    echo "   Run: tailscale funnel 3010"
fi

# 6. Check Log Files
echo ""
echo "6. Checking Logs..."
if [ -d "logs" ]; then
    ERROR_COUNT=$(tail -100 logs/error.log 2>/dev/null | grep -c "error" || echo "0")
    if [ "$ERROR_COUNT" -gt 0 ]; then
        echo -e "   ${YELLOW}⚠ Found $ERROR_COUNT recent errors in logs${NC}"
        echo "   Check: tail -20 logs/error.log"
    else
        echo -e "   ${GREEN}✓ No recent errors in logs${NC}"
    fi
else
    echo -e "   ${YELLOW}⚠ Logs directory not found${NC}"
fi

echo ""
echo "==================================="
echo "Health check complete!"