/**
 * @fileoverview T1.5 — Structured error response schema for write tools.
 *
 * Standardizes the failure shape every write tool returns so callers can branch
 * deterministically on `error_type`, judge whether to retry on `retry_safe`, and
 * surface the same `suggested_fix` to the LLM/operator without wrapping prose.
 *
 * @module src/utils/internal/structuredError
 */
import { BaseErrorCode, McpError } from "../../types-global/errors.js";

export type StructuredErrorType =
  | "anchor_not_found"
  | "duplicate_match"
  | "timeout"
  | "connection_lost"
  | "verification_failed"
  | "hash_mismatch"
  | "lock_timeout"
  | "validation_error"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "rate_limited"
  | "service_unavailable"
  | "internal_error";

export interface StructuredErrorContext {
  file?: string;
  operation?: string;
  elapsed_ms?: number;
  [key: string]: unknown;
}

export interface StructuredError {
  error_type: StructuredErrorType;
  message: string;
  suggested_fix: string | null;
  retry_safe: boolean;
  context: StructuredErrorContext;
}

const RETRY_SAFE_BY_TYPE: Record<StructuredErrorType, boolean> = {
  anchor_not_found: false,
  duplicate_match: false,
  timeout: true,
  connection_lost: true,
  verification_failed: false,
  hash_mismatch: false,
  lock_timeout: true,
  validation_error: false,
  not_found: false,
  conflict: false,
  unauthorized: false,
  rate_limited: true,
  service_unavailable: true,
  internal_error: false,
};

const SUGGESTED_FIX_BY_TYPE: Record<StructuredErrorType, string | null> = {
  anchor_not_found:
    "Verify the search/anchor text exists in the target file. Read the file first and copy the exact text including whitespace.",
  duplicate_match:
    "The search pattern matches multiple locations. Add more surrounding context to make the match unique, or set replaceAll=true if all matches should be replaced.",
  timeout:
    "Operation exceeded the time budget. Retry with a smaller payload or wait for upstream load to subside.",
  connection_lost:
    "Network/transport failure to the Obsidian REST API. Confirm the plugin is running and Tailscale Funnel is up, then retry.",
  verification_failed:
    "Write reported success but read-back hash did not match the expected state. Re-read the file to determine actual state before retrying.",
  hash_mismatch:
    "The file changed between the caller's last read and this write. Re-read the file, recompute expected_content_hash from the fresh content, then retry.",
  lock_timeout:
    "Another write to this file is in progress and did not release within the timeout window. Retry shortly.",
  validation_error:
    "Tool inputs failed schema validation. Check parameter names, types, and required fields.",
  not_found:
    "Target file or note does not exist. Verify the path is vault-relative and that the file has been created.",
  conflict:
    "Operation would overwrite existing state. Pass overwriteIfExists=true if that is intended, or change the target.",
  unauthorized:
    "Obsidian REST API rejected the API key. Check OBSIDIAN_API_KEY / per-vault apiKey in .env.",
  rate_limited: "Slow down request rate and retry.",
  service_unavailable:
    "Obsidian REST API is temporarily unreachable. Will retry automatically; if persistent, restart the Obsidian plugin.",
  internal_error: null,
};

/**
 * Maps an `McpError` to a structured error suitable for tool responses.
 */
export function fromMcpError(
  error: McpError,
  context: StructuredErrorContext = {},
): StructuredError {
  const errorType = mapMcpCode(error.code);
  return {
    error_type: errorType,
    message: error.message,
    suggested_fix: SUGGESTED_FIX_BY_TYPE[errorType],
    retry_safe: RETRY_SAFE_BY_TYPE[errorType],
    context: { ...context, ...sanitizeDetails(error.details) },
  };
}

/**
 * Wraps an arbitrary thrown value into a structured error. Use in catch blocks
 * where the error origin is not guaranteed to be `McpError`.
 */
export function fromUnknown(
  error: unknown,
  context: StructuredErrorContext = {},
): StructuredError {
  if (error instanceof McpError) {
    return fromMcpError(error, context);
  }
  if (isStructuredError(error)) {
    return { ...error, context: { ...context, ...error.context } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    error_type: "internal_error",
    message,
    suggested_fix: SUGGESTED_FIX_BY_TYPE.internal_error,
    retry_safe: false,
    context,
  };
}

/**
 * Constructs a structured error directly from semantic intent. Prefer this over
 * `fromMcpError` when the calling site already knows the error type (e.g. a
 * verification step that detected a hash mismatch).
 */
export function buildStructuredError(
  errorType: StructuredErrorType,
  message: string,
  context: StructuredErrorContext = {},
  overrides: Partial<Pick<StructuredError, "suggested_fix" | "retry_safe">> = {},
): StructuredError {
  return {
    error_type: errorType,
    message,
    suggested_fix:
      overrides.suggested_fix !== undefined
        ? overrides.suggested_fix
        : SUGGESTED_FIX_BY_TYPE[errorType],
    retry_safe:
      overrides.retry_safe !== undefined
        ? overrides.retry_safe
        : RETRY_SAFE_BY_TYPE[errorType],
    context,
  };
}

export function isStructuredError(value: unknown): value is StructuredError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StructuredError).error_type === "string" &&
    typeof (value as StructuredError).message === "string" &&
    "retry_safe" in value &&
    "context" in value
  );
}

function mapMcpCode(code: BaseErrorCode): StructuredErrorType {
  switch (code) {
    case BaseErrorCode.NOT_FOUND:
      return "not_found";
    case BaseErrorCode.CONFLICT:
      return "conflict";
    case BaseErrorCode.UNAUTHORIZED:
    case BaseErrorCode.FORBIDDEN:
      return "unauthorized";
    case BaseErrorCode.VALIDATION_ERROR:
    case BaseErrorCode.PARSING_ERROR:
      return "validation_error";
    case BaseErrorCode.RATE_LIMITED:
      return "rate_limited";
    case BaseErrorCode.TIMEOUT:
      return "timeout";
    case BaseErrorCode.SERVICE_UNAVAILABLE:
      return "service_unavailable";
    default:
      return "internal_error";
  }
}

function sanitizeDetails(
  details: Record<string, unknown> | undefined,
): StructuredErrorContext {
  if (!details) return {};
  const out: StructuredErrorContext = {};
  for (const [k, v] of Object.entries(details)) {
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    } else if (Array.isArray(v) || typeof v === "object") {
      try {
        out[k] = JSON.parse(JSON.stringify(v));
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}
