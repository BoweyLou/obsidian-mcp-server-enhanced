# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

### Development Workflow
- **Build**: `npm run build` - Compiles TypeScript and makes dist/index.js executable
- **Start (stdio)**: `npm run start:stdio` - Runs server with stdio transport and debug logging
- **Start (http)**: `npm run start:http` - Runs server with HTTP transport and debug logging
- **Clean & rebuild**: `npm run rebuild` - Cleans dist directory and rebuilds
- **Format code**: `npm run format` - Formats all TypeScript, JavaScript, JSON, and Markdown files

### Debugging & Inspection
- **MCP Inspector**: `npm run inspect` - Launch MCP inspector for debugging
- **Stdio inspector**: `npm run inspect:stdio` - Inspect stdio transport specifically
- **HTTP inspector**: `npm run inspect:http` - Inspect HTTP transport specifically

### Documentation & Analysis
- **Generate docs**: `npm run docs:generate` - Generate TypeDoc documentation
- **Project tree**: `npm run tree` - Display project structure tree
- **Fetch API spec**: `npm run fetch:spec` - Fetch Obsidian REST API OpenAPI specification

## Operational Commands

### Server Lifecycle Management
- **Check running processes**: `ps aux | grep -E "(node.*dist|obsidian|mcp)" | grep -v grep`
- **Stop server gracefully**: `kill -TERM <process_id>` (get PID from ps command above)
- **Start in background**: `nohup npm run start:http > server.log 2>&1 & echo $!`
- **Check server status**: `curl -s http://127.0.0.1:3010/mcp` (should return auth error if working)
- **Check port usage**: `lsof -i :3010`

### Development Restart Workflow
When making changes or restarting the server:
1. `ps aux | grep "node.*dist" | grep -v grep` - Find running process
2. `kill -TERM <process_id>` - Stop existing server gracefully
3. `npm run build` - Rebuild after code changes
4. `npm run start:http` (foreground) or `nohup npm run start:http > server.log 2>&1 &` (background)
5. Check logs: `tail -f logs/combined.log` or `tail -f server.log`

### Log Monitoring & Debugging
- **View live logs**: `tail -f logs/combined.log`
- **Check recent errors**: `tail -20 logs/error.log`
- **View startup logs**: `tail -30 logs/info.log`
- **Background server logs**: `tail -f server.log` (if started with nohup)
- **All log levels available**: `debug.log`, `info.log`, `warn.log`, `error.log`, `combined.log`

### Troubleshooting

**Expected Build Warnings** (safe to ignore):
- `ExperimentalWarning: --experimental-loader may be removed` - Node.js evolution warning
- `[DEP0180] DeprecationWarning: fs.Stats constructor is deprecated` - Dependency issue, not code issue

**Common Issues**:
- **Port 3010 in use**: Check with `lsof -i :3010`, kill competing process
- **API key errors**: Ensure `OBSIDIAN_API_KEY` environment variable is set
- **Obsidian plugin not responding**: Verify Obsidian Local REST API plugin is running
- **Cache build failures**: Check `logs/error.log` for Obsidian API connectivity issues

**Server Health Checks**:
- HTTP endpoint responding: `curl -s http://127.0.0.1:3010/mcp` returns auth error (good)
- Process running: `ps aux | grep "node.*dist" | grep -v grep` shows process
- Logs show "Resources and tools registered successfully"
- No errors in `logs/error.log` during startup

### Claude.ai Remote MCP Connection Issues

**"Connection closed" or "Failed to call tool" errors in Claude.ai**:

1. **Run the health check script**:
   ```bash
   ./scripts/health-check.sh
   ```
   This will verify all components are running correctly.

2. **Ensure you're using the Tailscale URL, not localhost**:
   - ❌ Wrong: `http://127.0.0.1:3010/mcp`
   - ✅ Correct: `https://your-device.your-tailnet.ts.net/mcp?api_key=YOUR_API_KEY`
   
3. **Get your correct Tailscale URL**:
   ```bash
   tailscale status --self --json | grep DNSName
   ```
   Your URL format: `https://[DNSName without trailing dot]/mcp?api_key=[YOUR_API_KEY]`

4. **Verify Tailscale funnel is running**:
   ```bash
   ps aux | grep "tailscale.*funnel.*3010" | grep -v grep
   ```
   If not running: `tailscale funnel 3010`

5. **Test the full connection chain**:
   ```bash
   # Test local server
   curl -s http://127.0.0.1:3010/mcp
   
   # Test Tailscale funnel (should return auth error)
   curl -s https://your-device.your-tailnet.ts.net/mcp
   ```

**Quick Recovery Steps**:
```bash
# 1. Restart MCP server
ps aux | grep "node.*dist" | grep -v grep | awk '{print $2}' | xargs kill -TERM
npm run build && npm run start:http

# 2. Restart Tailscale funnel
pkill -f "tailscale.*funnel"
tailscale funnel 3010

# 3. Run health check
./scripts/health-check.sh
```

## Architecture Overview

### Core Structure
This is an enhanced MCP (Model Context Protocol) server that provides comprehensive access to Obsidian vaults through the Obsidian Local REST API plugin. The codebase follows a modular, service-oriented architecture:

### Key Components

**Entry Point** (`src/index.ts`):
- Manages application lifecycle and graceful shutdown
- Initializes shared services (ObsidianRestApiService, VaultCacheService)
- Handles process signals and error recovery

**MCP Server Core** (`src/mcp-server/server.ts`):
- Creates McpServer instances with capabilities registration
- Registers 15+ Obsidian tools for vault interaction
- Manages transport selection (stdio vs HTTP)

**Service Layer** (`src/services/`):
- `ObsidianRestApiService`: Typed client for Obsidian Local REST API
- `VaultCacheService`: Intelligent in-memory caching with periodic refresh
- Provides resilience and performance optimization

**Tool Architecture** (`src/mcp-server/tools/`):
Each tool follows a consistent pattern:
- `index.ts`: Registration and schema definition
- `logic.ts`: Core business logic implementation
- `registration.ts`: MCP server registration (if complex)

### Critical Service Dependencies

**Obsidian API Requirements**:
- Requires Obsidian Local REST API plugin installed and configured
- Uses API key authentication (set via `OBSIDIAN_API_KEY`)
- Performs startup health checks with retries

**Vault Cache Service**:
- Enabled by default (`OBSIDIAN_ENABLE_CACHE=true`)
- Builds initial cache on startup, refreshes every 10 minutes
- Provides fallback for search operations when API is unavailable
- Tools automatically update cache after modifications

### Transport Modes

**STDIO Transport** (`MCP_TRANSPORT_TYPE=stdio`):
- Single McpServer instance for local MCP clients
- Direct process communication

**HTTP Transport** (`MCP_TRANSPORT_TYPE=http`):
- **Session Mode** (`MCP_HTTP_STATELESS=false`, default): Per-session McpServer instances for traditional MCP clients
- **Stateless Mode** (`MCP_HTTP_STATELESS=true`): Single shared transport for Claude.ai Remote MCP integration
- Built-in authentication and CORS support
- Optimized for remote connections

### Configuration System

All configuration through environment variables in this priority order:
1. Process environment
2. `.env` file in project root
3. Default values in `src/config/index.ts`

Critical variables:
- `OBSIDIAN_API_KEY`: Required API key from Obsidian plugin
- `OBSIDIAN_BASE_URL`: Obsidian API endpoint (default: http://127.0.0.1:27123)
- `MCP_TRANSPORT_TYPE`: stdio|http (default: http)
- `MCP_HTTP_STATELESS`: true|false (default: false) - Enable stateless mode for Claude.ai compatibility

### Enhanced Features (This Fork)

**Claude.ai Remote Integration**:
- Native HTTP transport with URL parameter authentication
- Stateless mode for reliable Claude.ai Remote MCP connections
- Session-based mode for traditional MCP clients
- Simplified setup for Claude.ai Remote MCP servers
- Production-ready configuration

**Tailscale Security Integration**:
- Secure remote access via Tailscale Funnel
- Automatic HTTPS with Tailscale certificates
- End-to-end encryption for remote vault access

**Advanced Query Tools**:
- Deep Tasks plugin integration with natural date parsing
- Dataview DQL query execution
- 5 new advanced tools: periodic notes, block references, graph analysis, template system, smart linking

**Production Monitoring & Reliability**:
- Comprehensive health check script (`scripts/health-check.sh`)
- Intelligent monitoring with auto-restart (`scripts/monitor-mcp.sh`)
- macOS auto-start configuration (`scripts/setup-autostart.sh`)
- Dynamic port detection and Tailscale funnel management
- Enhanced logging for connection debugging

## File Modification Patterns

### Adding New Tools
1. Create tool directory in `src/mcp-server/tools/obsidian[ToolName]Tool/`
2. Follow the standard pattern: `index.ts`, `logic.ts`, optional `registration.ts`
3. Import and register in `src/mcp-server/server.ts`
4. Use shared service instances passed to registration functions

### Modifying Services
- ObsidianRestApiService methods follow REST API endpoints exactly
- VaultCacheService handles automatic cache invalidation
- Always use provided RequestContext for logging correlation

### Configuration Changes
- Add new environment variables to `src/config/index.ts`
- Update validation schemas using Zod
- Document in README.md environment variables table

## Common Patterns

### Error Handling
- Use centralized `ErrorHandler` from `src/utils/index.js`
- All functions accept `RequestContext` for operation correlation
- Log with appropriate levels: debug, info, warning, error, fatal

### Service Integration
- Services are instantiated once in `src/index.ts` and passed down
- Tools receive service instances via registration functions
- Always check cache readiness before using VaultCacheService

### Authentication & Security
- API key validation on every Obsidian API request
- Input sanitization using Zod schemas and custom sanitizers
- Rate limiting and request context tracking built-in