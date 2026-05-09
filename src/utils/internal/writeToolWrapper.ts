/**
 * @fileoverview T1.2/T1.3/T1.4/T1.5 + T2.2 — High-order wrapper applied to
 * every write-capable MCP tool's request handler.
 *
 * Pipeline (in order):
 *   1. T1.4 idempotency — UUID lookup, cached MCP response on hit.
 *   2. T2.2 lock acquisition — when `lockKey` is set, the handler runs
 *      inside `acquireWriteLock`, serializing concurrent writes on the
 *      same key (in-process mutex + cross-process temp-dir lock file with
 *      30s stale-takeover policy).
 *   3. Inner handler runs (which itself uses retryWithExponentialBackoff at
 *      the API-call sites, optionally calls preflightContentHash /
 *      assertContentHash for T2.3 hash pre-flight, and calls
 *      verifyContentMatch / verifyDeletion for T1.3 readback).
 *   4. T1.5 success path — annotate response with verification metadata if
 *      the inner handler attached it, and store under the idempotency UUID.
 *   5. T1.5 error path — every thrown error (including T2.2
 *      WriteLockTimeoutError and T2.3 HashMismatchError) is mapped to a
 *      structured error response. No silent fails, no raw McpError leaking
 *      through.
 *
 * **T2.1 transaction semantics (no separate wrapper code).** Every current
 * write tool issues at most one PUT per invocation, with all in-memory
 * composition (search/replace, frontmatter edits, tag edits, task edits)
 * computed before the PUT. A throw mid-composition exits before the PUT,
 * leaving the vault file untouched — the "no partial state" property of
 * T2.1's spec is satisfied by construction. For future multi-PUT tools,
 * use `withSnapshotRestore` from `./snapshotRestore.ts` for best-effort
 * compensation on mid-sequence failure.
 *
 * Usage in registration.ts:
 *   const result = await runWriteTool({
 *     toolName,
 *     idempotencyKey: params.idempotency_key,
 *     lockKey: buildWriteLockKey(params.vault, params.filePath),
 *     context,
 *     handler: async () => processObsidianFooBar(validatedParams, context, vm),
 *   });
 *   return result;  // already a CallToolResult
 *
 * @module src/utils/internal/writeToolWrapper
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "../../types-global/errors.js";
import { HashMismatchError } from "./contentHashPreflight.js";
import { getIdempotencyStore } from "./idempotencyStore.js";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";
import {
  StructuredError,
  fromMcpError,
  fromUnknown,
  isStructuredError,
} from "./structuredError.js";
import { acquireWriteLock, WriteLockTimeoutError } from "./writeLock.js";
import { WriteRetryExhaustedError } from "./writeRetry.js";

export interface RunWriteToolOptions<T> {
  toolName: string;
  /** Optional client-supplied UUID. Empty string / undefined disables caching. */
  idempotencyKey?: string;
  context: RequestContext;
  /** The actual tool logic. Returns whatever JSON-shaped object the tool already returns. */
  handler: () => Promise<T>;
  /** Targets used in error context if the handler throws before logging it. */
  errorContext?: Record<string, unknown>;
  /**
   * T2.2 — optional write lock key. When provided, the handler runs inside
   * `acquireWriteLock(lockKey, ...)` so concurrent writes on the same key
   * are serialized. Tools build keys like `${vaultId}:${filePath}`; pass
   * `undefined` for tools without a stable file identifier (e.g. activeFile).
   */
  lockKey?: string;
}

/** Marker key tools may attach to their response payload to surface verification. */
export const VERIFICATION_KEY = "verification";

/**
 * Per-key in-flight registry. When a duplicate idempotency UUID arrives while
 * the original call is still executing, later arrivals await the original's
 * promise and receive byte-identical results — closing the parallel-duplicate
 * gap that a cache-lookup-then-execute pattern leaves open (the cache is only
 * populated *after* the first call completes, so concurrent duplicates would
 * otherwise all miss the cache and execute fresh, serialized only by the
 * write lock).
 *
 * Keyed by `${toolName}::${idempotencyKey}`. The entry is removed in
 * `finally` after the original call resolves, regardless of success or error,
 * so subsequent (post-completion) retries with the same UUID hit the success
 * cache (success path) or are free to retry fresh (error path — errors are
 * not cached).
 */
const inFlightCalls = new Map<string, Promise<CallToolResult>>();

function inFlightKey(toolName: string, idempotencyKey: string): string {
  return `${toolName}::${idempotencyKey}`;
}

export async function runWriteTool<T extends object>(
  opts: RunWriteToolOptions<T>,
): Promise<CallToolResult> {
  const { toolName, idempotencyKey, context } = opts;

  const useIdempotency =
    typeof idempotencyKey === "string" && idempotencyKey.length > 0;

  if (!useIdempotency) {
    return executeWriteTool(opts);
  }

  // ---- T1.4 + parallel-duplicate fix: cache lookup, then in-flight join. ----
  const store = getIdempotencyStore();
  const lookup = store.lookup<CallToolResult>(toolName, idempotencyKey!);
  if (lookup.hit) {
    logger.info(
      `Idempotency hit for ${toolName} (key=${idempotencyKey}); returning cached result.`,
      { ...context, operation: "IdempotencyHit", toolName },
    );
    // Return the cached MCP response verbatim so the client sees identical bytes.
    return lookup.entry.result;
  }

  const key = inFlightKey(toolName, idempotencyKey!);
  const pending = inFlightCalls.get(key);
  if (pending) {
    logger.info(
      `Idempotency in-flight join for ${toolName} (key=${idempotencyKey}); awaiting original call.`,
      { ...context, operation: "IdempotencyInFlightJoin", toolName },
    );
    // Original call is still executing — await its promise and return the
    // exact CallToolResult it produces. Same bytes for every concurrent
    // duplicate, by construction.
    return pending;
  }

  // First call for this UUID. Register its promise *before* awaiting so any
  // concurrent duplicate that arrives while we're executing finds it.
  const promise = (async () => {
    try {
      return await executeWriteTool(opts);
    } finally {
      inFlightCalls.delete(key);
    }
  })();
  inFlightCalls.set(key, promise);
  return promise;
}

/**
 * Inner runner: lock + handler + success/error structured-response mapping +
 * idempotency-cache store. Always resolves with a CallToolResult (errors are
 * converted, never thrown). The outer `runWriteTool` wraps this in the cache
 * lookup + in-flight registry to dedupe concurrent duplicates.
 */
async function executeWriteTool<T extends object>(
  opts: RunWriteToolOptions<T>,
): Promise<CallToolResult> {
  const {
    toolName,
    idempotencyKey,
    context,
    handler,
    errorContext = {},
    lockKey,
  } = opts;

  const store = getIdempotencyStore();
  const useIdempotency =
    typeof idempotencyKey === "string" && idempotencyKey.length > 0;

  const startedAt = Date.now();

  try {
    // T2.2: serialize concurrent writes on the same lockKey. When no
    // lockKey is supplied, run the handler directly (e.g. tools targeting
    // the active file have no stable identifier to lock on).
    const responseObj = lockKey
      ? await acquireWriteLock(lockKey, handler, context)
      : await handler();
    const elapsed_ms = Date.now() - startedAt;

    // ---- T1.5 success path ----
    const successPayload = {
      ...responseObj,
      idempotency_key: useIdempotency ? idempotencyKey : null,
      elapsed_ms,
    };

    const callToolResult: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify(successPayload, null, 2),
        },
      ],
      isError: false,
    };

    if (useIdempotency) {
      store.store(toolName, idempotencyKey!, callToolResult);
    }

    return callToolResult;
  } catch (err) {
    const elapsed_ms = Date.now() - startedAt;

    // ---- T1.5 error path: ALWAYS structured ----
    let structured: StructuredError;

    if (err instanceof WriteRetryExhaustedError) {
      structured = err.structured;
    } else if (err instanceof HashMismatchError) {
      structured = err.structured;
    } else if (err instanceof WriteLockTimeoutError) {
      structured = err.structured;
    } else if (err instanceof McpError) {
      structured = fromMcpError(err, {
        ...errorContext,
        operation: toolName,
        elapsed_ms,
      });
    } else if (isStructuredError(err)) {
      structured = err;
    } else {
      structured = fromUnknown(err, {
        ...errorContext,
        operation: toolName,
        elapsed_ms,
      });
    }

    logger.error(
      `Write tool '${toolName}' returning structured error: ${structured.error_type}`,
      err instanceof Error ? err : undefined,
      {
        ...context,
        operation: toolName,
        error_type: structured.error_type,
        retry_safe: structured.retry_safe,
        elapsed_ms,
      },
    );

    const errorPayload = {
      success: false,
      error: structured,
      idempotency_key: useIdempotency ? idempotencyKey : null,
      elapsed_ms,
    };

    const callToolResult: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify(errorPayload, null, 2),
        },
      ],
      isError: true,
    };

    // Errors are NOT cached under idempotency keys — a retry with the same
    // UUID after a transport failure should be allowed to actually retry the
    // write rather than re-receive the failure. (Concurrent duplicates that
    // joined the in-flight promise still receive these identical error
    // bytes; that's correct — they were "the same call".)
    return callToolResult;
  }
}

/** Zod schema fragment to add `idempotency_key` to a write tool's input. */
export const idempotencyKeyDescription =
  "Optional client-supplied UUID. If the same key is sent twice within 60s, the second call is a no-op and returns the cached result. Closes delete+rewrite race conditions on retry.";
