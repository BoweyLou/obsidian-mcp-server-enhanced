/**
 * @fileoverview T1.2 — Exponential-backoff retry wrapper for Obsidian write calls.
 *
 * Spec: 1s → 2s → 4s → halt. After 3 failed attempts, surface a structured
 * error to the caller. Used by all 7 write-capable MCP tools to absorb
 * transient network/REST-API hiccups without cascading partial writes.
 *
 * Distinct from `retryWithDelay` (fixed-delay; used for read-side existence
 * checks). Keep this one focused on writes so the shape stays opinionated.
 *
 * @module src/utils/internal/writeRetry
 */
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";
import {
  StructuredError,
  buildStructuredError,
  fromMcpError,
  fromUnknown,
} from "./structuredError.js";

/** Total attempts = 3 (initial 1s wait before retry, then 2s, then 4s). */
export const DEFAULT_WRITE_RETRY_DELAYS_MS = [1000, 2000, 4000];

export interface WriteRetryOptions {
  operationName: string;
  context: RequestContext;
  /** Override the default 1s/2s/4s delay schedule (rare; keep for tests). */
  delaysMs?: number[];
  /** Filter retryable errors. Default: retry on transport/transient signatures. */
  shouldRetry?: (error: unknown) => boolean;
  /** Extra fields stamped on the structured error if all attempts fail. */
  errorContext?: Record<string, unknown>;
}

/** Thrown when retries are exhausted. Carries a fully-formed StructuredError. */
export class WriteRetryExhaustedError extends Error {
  public readonly structured: StructuredError;
  constructor(structured: StructuredError) {
    super(structured.message);
    this.name = "WriteRetryExhaustedError";
    this.structured = structured;
  }
}

const TRANSIENT_MCP_CODES = new Set<BaseErrorCode>([
  BaseErrorCode.SERVICE_UNAVAILABLE,
  BaseErrorCode.TIMEOUT,
  BaseErrorCode.RATE_LIMITED,
]);

/** Default retry predicate — only transient transport/upstream errors. */
export function defaultShouldRetryWrite(error: unknown): boolean {
  if (error instanceof McpError) {
    return TRANSIENT_MCP_CODES.has(error.code);
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("socket hang up") ||
      msg.includes("network error")
    );
  }
  return false;
}

/**
 * Executes a write operation with the spec's exponential-backoff schedule.
 * Resolves with the operation result on the first successful attempt; if all
 * attempts fail, throws `WriteRetryExhaustedError` with a `StructuredError`
 * payload that callers should surface verbatim.
 */
export async function retryWithExponentialBackoff<T>(
  operation: () => Promise<T>,
  options: WriteRetryOptions,
): Promise<T> {
  const {
    operationName,
    context,
    delaysMs = DEFAULT_WRITE_RETRY_DELAYS_MS,
    shouldRetry = defaultShouldRetryWrite,
    errorContext = {},
  } = options;

  const totalAttempts = delaysMs.length + 1; // initial attempt + retries
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isFinalAttempt = attempt === totalAttempts;
      const retryable = shouldRetry(error);

      if (isFinalAttempt || !retryable) {
        const elapsed_ms = Date.now() - startedAt;

        // Non-retryable on first attempt: rethrow the original error as-is so
        // the calling tool's own catch logic can branch on McpError codes
        // (e.g. NOT_FOUND fallback paths). The outer runWriteTool wrapper
        // will still translate it into a structured error response if it
        // bubbles all the way out.
        if (!retryable && attempt === 1) {
          throw error;
        }

        const structured =
          error instanceof McpError
            ? fromMcpError(error, {
                ...errorContext,
                operation: operationName,
                elapsed_ms,
                attempts: attempt,
                retried: attempt > 1,
              })
            : fromUnknown(error, {
                ...errorContext,
                operation: operationName,
                elapsed_ms,
                attempts: attempt,
                retried: attempt > 1,
              });

        // Force error_type to connection_lost / timeout when the underlying
        // failure looks like transport, even if BaseErrorCode mapped it
        // generically. This keeps "retry_safe" honest.
        const enriched = enrichTransportType(structured, error);

        logger.error(
          `Write '${operationName}' failed definitively after ${attempt} attempt(s)`,
          error instanceof Error ? error : undefined,
          { ...context, operation: operationName, attempt, elapsed_ms },
        );

        throw new WriteRetryExhaustedError(enriched);
      }

      // Retryable + not last attempt — wait per schedule and try again.
      const delay = delaysMs[attempt - 1];
      logger.warning(
        `Write '${operationName}' attempt ${attempt}/${totalAttempts} failed (${
          error instanceof Error ? error.message : String(error)
        }). Retrying in ${delay}ms...`,
        { ...context, operation: operationName, attempt, delayMs: delay },
      );
      await sleep(delay);
    }
  }

  // Loop fell through without returning — defensive fallback.
  const elapsed_ms = Date.now() - startedAt;
  throw new WriteRetryExhaustedError(
    buildStructuredError(
      "internal_error",
      `Write '${operationName}' exited retry loop unexpectedly`,
      { ...errorContext, operation: operationName, elapsed_ms },
    ),
  );
}

function enrichTransportType(
  structured: StructuredError,
  error: unknown,
): StructuredError {
  if (
    structured.error_type === "service_unavailable" ||
    structured.error_type === "internal_error"
  ) {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("timeout") || msg.includes("etimedout")) {
        return { ...structured, error_type: "timeout", retry_safe: true };
      }
      if (
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("socket hang up") ||
        msg.includes("network error") ||
        msg.includes("no response received")
      ) {
        return { ...structured, error_type: "connection_lost", retry_safe: true };
      }
    }
  }
  return structured;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
