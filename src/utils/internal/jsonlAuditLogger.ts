/**
 * @fileoverview T3.1 JSONL audit logger for MCP tool calls.
 *
 * Emits one JSON row per call to a rolling file with size-based rotation.
 * Wraps tool handlers transparently — never alters return values or thrown errors.
 * Disabled mode (MCP_AUDIT_LOG_ENABLED=false) returns the original handler reference
 * for zero-overhead pass-through.
 *
 * @module src/utils/internal/jsonlAuditLogger
 */
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, statSync, promises as fsp } from "fs";
import path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../../config/index.js";
import { getHealthMetrics, HealthMetrics } from "./healthMetrics.js";
import { logger } from "./logger.js";

const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_MAX_FILES = 7;

/**
 * T3.2 — async-local request context. The HTTP transport extracts
 * x-cloud-trace-context (Google Cloud Trace, used by Anthropic's
 * proxy) and x-anthropic-client per request, then runs MCP dispatch
 * inside `withAuditRequestContext`. Any tool handler invoked
 * downstream sees these values via this store. The stdio transport
 * never sets them, so trace_id and client_type stay null there.
 */
export interface AuditRequestContext {
  traceId?: string | null;
  clientType?: string | null;
}

export const auditRequestContextStorage =
  new AsyncLocalStorage<AuditRequestContext>();

export function withAuditRequestContext<T>(
  ctx: AuditRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return auditRequestContextStorage.run(ctx, fn);
}

export interface AuditLoggerOptions {
  enabled: boolean;
  logPath: string;
  maxSizeBytes?: number;
  maxFiles?: number;
  /** T3.3 — optional health metrics sink. Defaults to the process singleton. */
  metrics?: HealthMetrics;
}

export interface AuditRow {
  ts: string;
  request_id: string;
  tool: string;
  vault: string | null;
  target_file: string | null;
  args_bytes: number;
  elapsed_ms: number;
  outcome: "success" | "error";
  error_type: string | null;
  trace_id: string | null;
  client_type: string | null;
}

type AnyHandler = (...args: unknown[]) => unknown;

export class JsonlAuditLogger {
  public readonly enabled: boolean;
  private readonly logPath: string;
  private readonly maxSizeBytes: number;
  private readonly maxFiles: number;
  private readonly metrics: HealthMetrics;
  private currentSize = 0;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(opts: AuditLoggerOptions) {
    this.enabled = opts.enabled;
    this.logPath = opts.logPath;
    this.maxSizeBytes = opts.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.metrics = opts.metrics ?? getHealthMetrics();

    if (this.enabled) {
      this.initSync();
    }
  }

  private initSync(): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      if (existsSync(this.logPath)) {
        this.currentSize = statSync(this.logPath).size;
      }
    } catch {
      // initialization failures are non-fatal — first write attempt will surface them
      this.currentSize = 0;
    }
  }

  /**
   * Wrap a tool handler so each invocation produces an audit row.
   * When disabled, returns the original handler reference (no allocation, no closure).
   */
  public wrapHandler<T extends AnyHandler>(toolName: string, handler: T): T {
    if (!this.enabled) return handler;
    const self = this;
    const wrapped: AnyHandler = async (...args: unknown[]) => {
      const start = process.hrtime.bigint();
      const params = args[0];
      let outcome: "success" | "error" = "success";
      let errorType: string | null = null;
      let result: unknown;
      let thrown: unknown = undefined;
      let didThrow = false;
      try {
        result = await handler(...args);
        if (
          result &&
          typeof result === "object" &&
          (result as { isError?: boolean }).isError === true
        ) {
          outcome = "error";
          errorType = "tool_returned_error";
        }
      } catch (err) {
        outcome = "error";
        errorType = (err as { constructor?: { name?: string } } | null)
          ?.constructor?.name ?? "UnknownError";
        thrown = err;
        didThrow = true;
      }
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      const reqCtx = auditRequestContextStorage.getStore();
      const row: AuditRow = {
        ts: new Date().toISOString(),
        request_id: randomUUID(),
        tool: toolName,
        vault: extractVault(params),
        target_file: extractTargetFile(params),
        args_bytes: estimateBytes(params),
        elapsed_ms: Math.round(elapsedMs * 1000) / 1000,
        outcome,
        error_type: errorType,
        trace_id: reqCtx?.traceId ?? null,
        client_type: reqCtx?.clientType ?? null,
      };
      self.metrics.recordRequest();
      if (outcome === "error") self.metrics.recordError();
      self.logCall(row);
      if (didThrow) throw thrown;
      return result;
    };
    return wrapped as T;
  }

  /**
   * Enqueue a row write. Fire-and-forget — never blocks the caller.
   * Failures are reported via winston but never propagate.
   */
  public logCall(row: AuditRow): void {
    if (!this.enabled) return;
    this.inFlight = this.inFlight
      .then(() => this.writeRow(row))
      .catch((err) => {
        try {
          logger.warning("JSONL audit log write failed", {
            requestId: "audit-log-write-failure",
            timestamp: new Date().toISOString(),
            tool: row.tool,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // intentionally swallow — audit logger must never break a tool call
        }
      });
  }

  /** Wait for all queued writes to complete. Test-only helper. */
  public async flush(): Promise<void> {
    await this.inFlight;
  }

  private async writeRow(row: AuditRow): Promise<void> {
    const line = JSON.stringify(row) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.currentSize > 0 && this.currentSize + bytes > this.maxSizeBytes) {
      await this.rotate();
    }
    await fsp.appendFile(this.logPath, line, "utf8");
    this.currentSize += bytes;
  }

  private async rotate(): Promise<void> {
    const maxBackups = this.maxFiles - 1;
    const oldest = `${this.logPath}.${maxBackups}`;
    if (existsSync(oldest)) {
      await fsp.unlink(oldest);
    }
    for (let i = maxBackups - 1; i >= 1; i--) {
      const src = `${this.logPath}.${i}`;
      if (existsSync(src)) {
        await fsp.rename(src, `${this.logPath}.${i + 1}`);
      }
    }
    if (existsSync(this.logPath)) {
      await fsp.rename(this.logPath, `${this.logPath}.1`);
    }
    this.currentSize = 0;
  }
}

function extractVault(params: unknown): string | null {
  if (params && typeof params === "object" && "vault" in params) {
    const v = (params as { vault?: unknown }).vault;
    return typeof v === "string" ? v : null;
  }
  return null;
}

function extractTargetFile(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  for (const key of ["filePath", "targetIdentifier", "dirPath", "path"]) {
    const v = p[key];
    if (typeof v === "string") return v;
  }
  return null;
}

function estimateBytes(params: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(params ?? null), "utf8");
  } catch {
    return 0;
  }
}

/**
 * Process-wide singleton, wired to config.
 * Lazily constructed so unit tests can build their own instance without env coupling.
 */
let singleton: JsonlAuditLogger | undefined;
export function getAuditLogger(): JsonlAuditLogger {
  if (!singleton) {
    singleton = new JsonlAuditLogger({
      enabled: config.auditLogEnabled,
      logPath: path.join(config.logsPath, "_mcp_server_log.jsonl"),
    });
  }
  return singleton;
}

/**
 * Monkey-patch server.tool so every registered handler is wrapped with the audit logger.
 * Idempotent and a no-op when the logger is disabled.
 */
export function instrumentMcpServerTools(
  server: McpServer,
  auditor: JsonlAuditLogger = getAuditLogger(),
): void {
  if (!auditor.enabled) return;
  const serverWithTool = server as unknown as {
    tool: (...args: unknown[]) => unknown;
    __auditInstrumented?: boolean;
  };
  if (serverWithTool.__auditInstrumented) return;
  const original = serverWithTool.tool.bind(server);
  serverWithTool.tool = (...args: unknown[]) => {
    const lastIdx = args.length - 1;
    const handler = args[lastIdx];
    if (typeof handler !== "function") {
      return original(...args);
    }
    const toolName = typeof args[0] === "string" ? args[0] : "unknown";
    args[lastIdx] = auditor.wrapHandler(toolName, handler as AnyHandler);
    return original(...args);
  };
  serverWithTool.__auditInstrumented = true;
}
