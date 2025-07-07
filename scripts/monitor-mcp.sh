#!/bin/bash

# MCP Server Monitor Script
# This script monitors the MCP server and Tailscale funnel, restarting them if needed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$PROJECT_DIR/logs/monitor.log"
PID_FILE="$PROJECT_DIR/.mcp-server.pid"
FUNNEL_PID_FILE="$PROJECT_DIR/.tailscale-funnel.pid"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

check_mcp_server() {
    # Find which port the MCP server is running on
    local port=""
    for p in 3010 3011 3012 3013; do
        if lsof -i :$p >/dev/null 2>&1; then
            if curl -s http://127.0.0.1:$p/mcp | grep -q "Unauthorized"; then
                port=$p
                break
            fi
        fi
    done
    
    if [ -z "$port" ]; then
        log "ERROR: MCP server not running on expected ports (3010-3013)"
        return 1
    fi
    
    MCP_PORT=$port
    return 0
}

check_tailscale_funnel() {
    # Check if Tailscale funnel is running by checking status
    local expected_port=${MCP_PORT:-3010}
    if tailscale funnel status | grep -q "proxy http://127.0.0.1:$expected_port"; then
        return 0
    else
        log "ERROR: Tailscale funnel not running on port $expected_port"
        return 1
    fi
}

start_mcp_server() {
    log "Starting MCP server..."
    cd "$PROJECT_DIR"
    
    # Kill any existing server
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        kill -TERM "$OLD_PID" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    
    # Start new server
    nohup npm run start:http > "$PROJECT_DIR/server.log" 2>&1 &
    echo $! > "$PID_FILE"
    
    # Wait for server to start
    sleep 5
    
    if check_mcp_server; then
        log "✓ MCP server started successfully"
        return 0
    else
        log "✗ Failed to start MCP server"
        return 1
    fi
}

start_tailscale_funnel() {
    local port=${MCP_PORT:-3010}
    log "Starting Tailscale funnel on port $port..."
    
    # Reset any existing configuration
    tailscale serve reset 2>/dev/null || true
    
    # Start new funnel in background
    tailscale funnel --bg $port > "$PROJECT_DIR/funnel.log" 2>&1
    
    # Wait for funnel to start
    sleep 3
    
    if check_tailscale_funnel; then
        log "✓ Tailscale funnel started successfully on port $port"
        return 0
    else
        log "✗ Failed to start Tailscale funnel on port $port"
        return 1
    fi
}

monitor_loop() {
    log "Starting MCP monitoring..."
    
    while true; do
        # Check MCP server
        if ! check_mcp_server; then
            log "MCP server check failed, restarting..."
            start_mcp_server
        fi
        
        # Check Tailscale funnel
        if ! check_tailscale_funnel; then
            log "Tailscale funnel check failed, restarting..."
            start_tailscale_funnel
        fi
        
        # Sleep for 60 seconds before next check
        sleep 60
    done
}

# Main execution
case "${1:-}" in
    start)
        if ! check_mcp_server; then
            start_mcp_server
        else
            log "MCP server already running"
        fi
        
        if ! check_tailscale_funnel; then
            start_tailscale_funnel
        else
            log "Tailscale funnel already running"
        fi
        
        monitor_loop
        ;;
    stop)
        log "Stopping MCP server and Tailscale funnel..."
        
        # Stop MCP server
        if [ -f "$PID_FILE" ]; then
            kill -TERM "$(cat "$PID_FILE")" 2>/dev/null || true
            rm -f "$PID_FILE"
        fi
        
        # Stop Tailscale funnel
        if [ -f "$FUNNEL_PID_FILE" ]; then
            kill -TERM "$(cat "$FUNNEL_PID_FILE")" 2>/dev/null || true
            rm -f "$FUNNEL_PID_FILE"
        fi
        
        # Kill monitoring script
        pkill -f "monitor-mcp.sh start" || true
        
        log "Services stopped"
        ;;
    status)
        echo -e "${YELLOW}MCP Server Status:${NC}"
        if check_mcp_server; then
            echo -e "${GREEN}✓ MCP server is running and healthy on port $MCP_PORT${NC}"
        else
            echo -e "${RED}✗ MCP server is not running or unhealthy${NC}"
        fi
        
        echo -e "\n${YELLOW}Tailscale Funnel Status:${NC}"
        if check_tailscale_funnel; then
            echo -e "${GREEN}✓ Tailscale funnel is running on port $MCP_PORT${NC}"
        else
            echo -e "${RED}✗ Tailscale funnel is not running on port ${MCP_PORT:-3010}${NC}"
        fi
        
        echo -e "\n${YELLOW}Recent Logs:${NC}"
        tail -5 "$LOG_FILE" 2>/dev/null || echo "No logs available"
        ;;
    *)
        echo "Usage: $0 {start|stop|status}"
        echo
        echo "  start  - Start MCP server, Tailscale funnel, and monitoring"
        echo "  stop   - Stop all services"
        echo "  status - Check current status"
        exit 1
        ;;
esac