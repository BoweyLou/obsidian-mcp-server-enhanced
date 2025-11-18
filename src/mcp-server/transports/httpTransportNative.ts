/**
 * @fileoverview Pure Node.js HTTP implementation for MCP Streamable HTTP transport.
 * Removes Hono dependency to eliminate response handling conflicts with MCP SDK.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { randomUUID } from "node:crypto";
import { URL } from "url";
import { config } from "../../config/index.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../utils/index.js";
import { VaultManager } from "../../services/vaultManager/index.js";
import { handleChatGptLayerRequest } from "../../chatgpt/layer.js";

const HTTP_PORT = config.mcpHttpPort;
const HTTP_HOST = config.mcpHttpHost;
const MCP_ENDPOINT_PATH = "/mcp";

/**
 * Stores active `StreamableHTTPServerTransport` instances, keyed by session ID.
 */
const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

/**
 * Stores the last activity timestamp for each session.
 */
const sessionActivity: Record<string, number> = {};

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_GC_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_PORT_RETRIES = 15;

/**
 * Checks if a port is in use.
 */
async function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE");
      })
      .once("listening", () => {
        tempServer.close(() => resolve(false));
      })
      .listen(port, host);
  });
}

/**
 * Sets CORS headers on the response.
 */
function setCorsHeaders(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

/**
 * Validates the API key from URL query parameter.
 * Claude.ai will connect with: http://127.0.0.1:3010/mcp?api_key=YOUR_MCP_AUTH_KEY
 */
function validateApiKey(req: http.IncomingMessage, url: URL): boolean {
  // Use the MCP authentication key for MCP authentication
  // If no MCP auth key is configured, skip authentication
  if (!config.mcpAuthKey || config.mcpAuthKey === "dummy") {
    logger.debug("API key validation skipped - no MCP auth key configured");
    return true;
  }

  // Check for API key in query parameter
  const apiKeyFromQuery = url.searchParams.get('api_key');
  
  const validationContext = requestContextService.createRequestContext({
    operation: "ApiKeyValidation",
    hasApiKeyInQuery: !!apiKeyFromQuery,
    apiKeyMatches: apiKeyFromQuery === config.mcpAuthKey,
    queryParams: Array.from(url.searchParams.keys()),
    apiKeyLength: apiKeyFromQuery?.length || 0,
    configKeyLength: config.mcpAuthKey.length,
    // Show first/last 4 chars of keys for debugging
    apiKeyPreview: apiKeyFromQuery ? `${apiKeyFromQuery.substring(0, 4)}...${apiKeyFromQuery.substring(apiKeyFromQuery.length - 4)}` : "none",
    configKeyPreview: `${config.mcpAuthKey.substring(0, 4)}...${config.mcpAuthKey.substring(config.mcpAuthKey.length - 4)}`,
  });
  logger.debug("API key validation", validationContext);
  
  if (apiKeyFromQuery && apiKeyFromQuery === config.mcpAuthKey) {
    return true;
  }

  return false;
}

/**
 * Handles OPTIONS requests for CORS preflight.
 */
function handleOptions(res: http.ServerResponse) {
  setCorsHeaders(res);
  res.writeHead(200);
  res.end();
}

/**
 * Parses request body as JSON.
 */
async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Starts the pure Node.js HTTP server for MCP transport.
 */
export async function startHttpTransport(
  createServerInstanceFn: () => Promise<McpServer>,
  parentContext: RequestContext,
  vaultManager: VaultManager,
): Promise<http.Server> {
  const transportContext = requestContextService.createRequestContext({
    ...parentContext,
    transportType: "HTTP",
    component: "HttpTransportSetup",
  });

  // Start session garbage collector
  setInterval(() => {
    const now = Date.now();
    for (const sessionId in sessionActivity) {
      if (now - sessionActivity[sessionId] > SESSION_TIMEOUT_MS) {
        const gcContext = requestContextService.createRequestContext({
          operation: "SessionGarbageCollector",
          sessionId,
        });
        logger.info(`Session ${sessionId} timed out due to inactivity. Cleaning up.`, gcContext);
        const transport = httpTransports[sessionId];
        if (transport) {
          transport.close();
        }
        delete sessionActivity[sessionId];
      }
    }
  }, SESSION_GC_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    try {
      setCorsHeaders(res);

      const url = new URL(req.url!, `http://${req.headers.host}`);
      
      // Log all incoming requests for debugging
      const requestContext = requestContextService.createRequestContext({
        operation: "IncomingHTTPRequest",
        method: req.method || "unknown",
        url: req.url || "unknown",
        headers: JSON.stringify({
          host: req.headers.host,
          "user-agent": req.headers["user-agent"],
          "mcp-session-id": req.headers["mcp-session-id"],
          authorization: req.headers.authorization ? "[REDACTED]" : undefined,
        }),
        query: url.search,
      });
      logger.info(`Incoming HTTP request: ${req.method} ${req.url}`, requestContext);
      
      if (
        await handleChatGptLayerRequest({
          req,
          res,
          url,
          parentContext: requestContext,
          parseJsonBody: () => parseJsonBody(req),
          ensureAuthenticated: () => validateApiKey(req, url),
          vaultManager,
          mcpEndpointPath: MCP_ENDPOINT_PATH,
        })
      ) {
        return;
      }

      // Only handle our MCP endpoint
      if (url.pathname !== MCP_ENDPOINT_PATH) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      // Handle OPTIONS for CORS
      if (req.method === "OPTIONS") {
        handleOptions(res);
        return;
      }

      // Validate API key if authentication is configured
      if (!validateApiKey(req, url)) {
        logger.warning(`Authentication failed for request: ${req.method} ${req.url}`, {
          ...requestContext,
          authFailure: true,
          hasApiKeyInQuery: url.searchParams.has('api_key'),
          configuredApiKey: config.obsidianApiKey ? "[SET]" : "[NOT SET]",
        });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: Invalid or missing API key" },
          id: null,
        }));
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string;
      let transport: StreamableHTTPServerTransport | undefined;
      
      if (config.mcpHttpStateless) {
        // In stateless mode, use a single shared transport
        transport = httpTransports["stateless"] || undefined;
      } else {
        // In session mode, use session-based transport lookup
        transport = sessionId ? httpTransports[sessionId] : undefined;
        if (transport && sessionId) {
          sessionActivity[sessionId] = Date.now();
        }
      }

      if (req.method === "POST") {
        const body = await parseJsonBody(req);
        
        // Log POST body for debugging (without sensitive data)
        logger.debug(`POST request body`, {
          ...requestContext,
          bodyKeys: Object.keys(body || {}),
          method: body?.method,
          hasId: !!body?.id,
          hasParams: !!body?.params,
        });
        const isInitReq = isInitializeRequest(body);
        const requestId = body?.id || null;

        if (isInitReq) {
          logger.info(`Received InitializeRequest`, {
            ...requestContext,
            isInitReq: true,
            hasExistingTransport: !!transport,
            sessionId: sessionId || "none",
            statelessMode: config.mcpHttpStateless,
          });
          
          if (transport) {
            logger.warning("Received InitializeRequest on existing session. Closing old session.");
            await transport.close();
          }

          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: config.mcpHttpStateless ? undefined : () => randomUUID(),
            onsessioninitialized: (newId) => {
              if (config.mcpHttpStateless) {
                // In stateless mode, store under "stateless" key
                httpTransports["stateless"] = transport!;
                logger.info(`HTTP Stateless transport initialized`, transportContext);
              } else {
                // In session mode, store under session ID
                httpTransports[newId] = transport!;
                sessionActivity[newId] = Date.now();
                const sessionContext = requestContextService.createRequestContext({
                  operation: "sessionCreated",
                  newSessionId: newId,
                });
                logger.info(`HTTP Session created: ${newId}`, sessionContext);
              }
            },
          });

          transport.onclose = () => {
            const closedSessionId = transport!.sessionId;
            if (closedSessionId) {
              delete httpTransports[closedSessionId];
              delete sessionActivity[closedSessionId];
              const closeContext = requestContextService.createRequestContext({
                operation: "sessionClosed",
                closedSessionId,
              });
              logger.info(`HTTP Session closed: ${closedSessionId}`, closeContext);
            }
          };

          const mcpServer = await createServerInstanceFn();
          await mcpServer.connect(transport);
        } else if (!transport && !config.mcpHttpStateless) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32004, message: "Invalid or expired session ID" },
            id: requestId,
          }));
          return;
        } else if (!transport && config.mcpHttpStateless) {
          // In stateless mode, create transport if it doesn't exist
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            onsessioninitialized: (newId) => {
              httpTransports["stateless"] = transport!;
              logger.info(`HTTP Stateless transport initialized for non-init request`, transportContext);
            },
          });
          const mcpServer = await createServerInstanceFn();
          await mcpServer.connect(transport);
        }

        // Let MCP transport handle the request completely
        await transport!.handleRequest(req, res, body);
        
      } else if (req.method === "GET" || req.method === "DELETE") {
        if (!transport && !config.mcpHttpStateless) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32004, message: "Session not found or expired" },
            id: null,
          }));
          return;
        } else if (!transport && config.mcpHttpStateless) {
          // In stateless mode, create transport if it doesn't exist
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            onsessioninitialized: (newId) => {
              httpTransports["stateless"] = transport!;
              logger.info(`HTTP Stateless transport initialized for non-init request`, transportContext);
            },
          });
          const mcpServer = await createServerInstanceFn();
          await mcpServer.connect(transport);
        }

        // Let MCP transport handle the request completely
        await transport!.handleRequest(req, res);
        
      } else {
        res.writeHead(405);
        res.end("Method Not Allowed");
      }

    } catch (err) {
      const errorContext = requestContextService.createRequestContext({
        operation: "httpRequestError",
        method: req.method || "unknown",
        url: req.url || "unknown",
      });
      logger.error("Error handling HTTP request", {
        ...errorContext,
        error: err instanceof Error ? err.message : String(err),
      });
      
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }));
      }
    }
  });

  // Find available port
  let currentPort = HTTP_PORT;
  for (let i = 0; i <= MAX_PORT_RETRIES; i++) {
    currentPort = HTTP_PORT + i;
    
    if (await isPortInUse(currentPort, HTTP_HOST)) {
      logger.warning(`Port ${currentPort} is in use, trying next port...`);
      continue;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(currentPort, HTTP_HOST, () => {
          const serverAddress = `http://${HTTP_HOST}:${currentPort}${MCP_ENDPOINT_PATH}`;
          logger.info(`HTTP transport successfully listening at ${serverAddress}`);
          
          if (process.stdout.isTTY) {
            console.log(`\n🚀 MCP Server running in HTTP mode at: ${serverAddress}\n   (MCP Spec: 2025-03-26 Streamable HTTP Transport)\n`);
          }
          resolve();
        });
        server.on("error", reject);
      });
      
      return server;
    } catch (err: any) {
      if (err.code !== "EADDRINUSE") {
        throw err;
      }
    }
  }

  throw new Error(`Failed to bind to any port after ${MAX_PORT_RETRIES + 1} attempts`);
}
