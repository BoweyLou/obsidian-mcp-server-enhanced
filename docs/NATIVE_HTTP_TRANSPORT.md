# Native HTTP Transport Implementation

This document describes the implementation of a native Node.js HTTP transport for the MCP server, replacing the previous Hono-based implementation to resolve compatibility issues with Claude.ai's Remote MCP client.

## Problem Statement

The original HTTP transport implementation used the Hono web framework, which created conflicts with the MCP SDK's `StreamableHTTPServerTransport`. These conflicts manifested as:

- `ERR_HTTP_HEADERS_SENT` errors when Hono tried to write response headers after the MCP transport had already sent them
- Invalid HTTP status codes (`init["status"] must be in the range of 200 to 599`)
- Session management failures and connection instability
- Tool discovery issues where Claude.ai couldn't see registered MCP tools

## Root Cause Analysis

The core issue was a **response handling conflict** between two systems trying to manage the same HTTP response:

1. **MCP SDK's StreamableHTTPServerTransport**: Expects full control over Node.js `http.IncomingMessage` and `http.ServerResponse` objects
2. **Hono Framework**: Provides its own response abstraction and tries to manage response lifecycle

When both systems attempted to write headers and send responses, it created race conditions and invalid HTTP states.

## Solution: Native HTTP Transport

### Architecture Overview

The solution replaces Hono with a pure Node.js HTTP server implementation that:

- Gives the MCP SDK complete control over request/response handling
- Provides minimal HTTP routing for the single MCP endpoint
- Handles CORS, authentication, and error responses outside the MCP transport layer
- Maintains session management and garbage collection

### Key Implementation Details

#### File Structure
```
src/mcp-server/transports/
├── httpTransport.ts        # Original Hono-based implementation (deprecated)
├── httpTransportNative.ts  # New native Node.js implementation
└── stdioTransport.ts       # Unchanged stdio transport
```

#### Core Components

**1. Request Router**
```typescript
const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    handleOptions(res);
    return;
  }

  // Validate API key
  if (!validateApiKey(req, url)) {
    return sendUnauthorized(res);
  }

  // Route to MCP transport
  await transport.handleRequest(req, res, body);
});
```

**2. Authentication Layer**
```typescript
function validateApiKey(req: http.IncomingMessage, url: URL): boolean {
  // Support Authorization header (preferred)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.startsWith("Bearer ") 
      ? authHeader.slice(7) 
      : authHeader;
    if (token === config.obsidianApiKey) return true;
  }

  // Fallback: URL query parameter
  const apiKeyFromQuery = url.searchParams.get('api_key');
  return apiKeyFromQuery === config.obsidianApiKey;
}
```

**3. Session Management**
```typescript
// Session storage and cleanup
const httpTransports: Record<string, StreamableHTTPServerTransport> = {};
const sessionActivity: Record<string, number> = {};

// Automatic garbage collection
setInterval(() => {
  const now = Date.now();
  for (const sessionId in sessionActivity) {
    if (now - sessionActivity[sessionId] > SESSION_TIMEOUT_MS) {
      cleanupSession(sessionId);
    }
  }
}, SESSION_GC_INTERVAL_MS);
```

**4. MCP Transport Integration**
```typescript
// Let MCP SDK handle the request completely
await transport.handleRequest(req, res, body);

// No additional response handling needed
// MCP transport manages the entire response lifecycle
```

### Key Differences from Hono Implementation

| Aspect | Hono Implementation | Native Implementation |
|--------|-------------------|---------------------|
| **Response Handling** | Hono manages responses, conflicts with MCP | MCP SDK has full control |
| **Middleware** | Complex middleware chain | Simple pre-MCP validation |
| **Error Handling** | Framework error handling | Direct HTTP error responses |
| **CORS** | Hono CORS middleware | Manual CORS header setting |
| **Authentication** | Middleware-based | Function-based validation |
| **Session Management** | Framework-dependent | Manual session tracking |

### Configuration Changes

#### Environment Variables
```bash
# Required
MCP_TRANSPORT_TYPE=http
OBSIDIAN_API_KEY=your-obsidian-api-key

# Optional (if not set, uses OBSIDIAN_API_KEY)
MCP_AUTH_SECRET_KEY=separate-mcp-auth-key
```

#### Server Import Update
```typescript
// Old import
import { startHttpTransport } from "./transports/httpTransport.js";

// New import  
import { startHttpTransport } from "./transports/httpTransportNative.js";
```

### Authentication Modes

The native transport supports multiple authentication methods:

**1. Authorization Header (Preferred)**
```
Authorization: Bearer your-api-key
Authorization: your-api-key
```

**2. URL Query Parameter (Fallback)**
```
https://your-server.com/mcp?api_key=your-api-key
```

**3. No Authentication (Development)**
Set `OBSIDIAN_API_KEY=dummy` to disable authentication.

### Port Management

Automatic port conflict resolution:
```typescript
// Try ports 3010, 3011, 3012, etc.
for (let i = 0; i <= MAX_PORT_RETRIES; i++) {
  const currentPort = HTTP_PORT + i;
  if (await isPortInUse(currentPort, HTTP_HOST)) {
    continue; // Try next port
  }
  // Start server on available port
}
```

### Error Handling

Structured error responses following JSON-RPC 2.0 format:
```typescript
// Authentication error
{
  "jsonrpc": "2.0",
  "error": { 
    "code": -32001, 
    "message": "Unauthorized: Invalid or missing API key" 
  },
  "id": null
}

// Session not found
{
  "jsonrpc": "2.0",
  "error": { 
    "code": -32004, 
    "message": "Session not found or expired" 
  },
  "id": null
}
```

## Performance Improvements

### Reduced Overhead
- No framework middleware chain
- Direct HTTP handling
- Minimal request processing before MCP delegation

### Memory Efficiency
- Manual session cleanup vs framework overhead
- Explicit garbage collection of stale sessions
- No framework abstractions or unused features

### Stability Improvements
- Eliminates response handling race conditions
- Reduces complexity and potential failure points
- More predictable request/response lifecycle

## Security Considerations

### Authentication
- API key validation before MCP processing
- Support for multiple authentication methods
- Configurable authentication bypass for development

### CORS Configuration
```typescript
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID, Authorization");
res.setHeader("Access-Control-Allow-Credentials", "true");
```

### Session Security
- Automatic session expiration (30 minutes)
- Session ID validation
- Secure session cleanup on timeout

## Migration Guide

### For Existing Deployments

1. **Update imports** in `src/mcp-server/server.ts`
2. **Rebuild** the application: `npm run build`
3. **Restart** the server
4. **Verify** authentication is working
5. **Test** Claude.ai connectivity

### For New Deployments

1. Set `MCP_TRANSPORT_TYPE=http` in environment
2. Configure `OBSIDIAN_API_KEY` for authentication
3. Start server and verify port binding
4. Configure Tailscale Funnel if needed
5. Test MCP connectivity

## Troubleshooting

### Common Issues

**"Port already in use"**
- Server automatically tries next available port
- Check `logs/debug.log` for actual port used

**"Unauthorized" errors**
- Verify API key configuration
- Check Authorization header format
- Try query parameter fallback method

**"Session not found"**
- Sessions expire after 30 minutes of inactivity
- Restart Claude.ai integration to create new session
- Check server logs for session creation messages

### Debug Commands

```bash
# Check server status
curl http://localhost:3010/mcp

# Test authentication
curl -H "Authorization: your-api-key" http://localhost:3010/mcp

# Monitor logs
tail -f logs/debug.log
```

## Future Considerations

### Potential Enhancements
- Rate limiting implementation
- Request/response logging
- Metrics collection
- Health check endpoints
- WebSocket transport support

### Monitoring
- Session creation/destruction tracking
- Authentication failure alerts
- Performance metrics collection
- Error rate monitoring

## References

- [MCP Specification](https://github.com/modelcontextprotocol/modelcontextprotocol)
- [Node.js HTTP Module](https://nodejs.org/api/http.html)
- [Anthropic Remote MCP Documentation](https://docs.anthropic.com/en/docs/build-with-claude/computer-use)