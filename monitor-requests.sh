#!/bin/bash
# Monitor incoming HTTP requests to MCP server

echo "Monitoring HTTP requests to MCP server..."
echo "Press Ctrl+C to stop"
echo ""

# Monitor both debug and info logs for HTTP activity
tail -f logs/debug.log logs/info.log | grep -E "(HTTP|session|Session|POST.*mcp|GET.*mcp|DELETE.*mcp|api_key|closed|Connection)" --line-buffered | while read line; do
    echo "[$(date '+%H:%M:%S')] $line"
done