/**
 * @fileoverview T2.3 — Optional content-hash pre-flight check for write tools.
 *
 * Catches concurrent modifications: if a caller passes
 * `expected_content_hash` (SHA-256 hex of the content they last read), this
 * helper reads the file fresh and compares. A mismatch means someone else
 * (another tool call, Obsidian itself, an external editor) modified the file
 * between the caller's read and our write — we abort with a structured
 * `hash_mismatch` error rather than clobbering their changes.
 *
 * Backward compatible: skips entirely when `expectedHashHex` is undefined or
 * empty. Tools call this once, near the top of their logic, after they've
 * located the target file.
 *
 * @module src/utils/internal/contentHashPreflight
 */
import { ObsidianRestApiService } from "../../services/obsidianRestAPI/index.js";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";
import { buildStructuredError, StructuredError } from "./structuredError.js";
import { sha256, VerificationTarget } from "./writeVerification.js";

/**
 * Thrown when the caller's `expected_content_hash` does not match the
 * current file content. The wrapper turns this into a structured
 * `hash_mismatch` response.
 */
export class HashMismatchError extends Error {
  public readonly structured: StructuredError;
  constructor(structured: StructuredError) {
    super(structured.message);
    this.name = "HashMismatchError";
    this.structured = structured;
  }
}

async function readTarget(
  target: VerificationTarget,
  service: ObsidianRestApiService,
  context: RequestContext,
): Promise<string> {
  if (target.kind === "filePath") {
    return (await service.getFileContent(
      target.path,
      "markdown",
      context,
    )) as string;
  }
  if (target.kind === "activeFile") {
    return (await service.getActiveFile("markdown", context)) as string;
  }
  return (await service.getPeriodicNote(
    target.period,
    "markdown",
    context,
  )) as string;
}

/**
 * If `expectedHashHex` is provided, read the target and abort with
 * `HashMismatchError` when the SHA-256 of the current content differs.
 * No-op when `expectedHashHex` is undefined/empty.
 *
 * The "file not found" case is *not* a hash mismatch — we let the caller's
 * own existence check / create-if-needed logic handle missing files. We only
 * compare hashes when both sides have content.
 */
export async function preflightContentHash(
  target: VerificationTarget,
  expectedHashHex: string | undefined,
  service: ObsidianRestApiService,
  context: RequestContext,
): Promise<void> {
  if (!expectedHashHex || expectedHashHex.trim().length === 0) {
    return;
  }

  const expected = expectedHashHex.trim().toLowerCase();
  let actualContent: string;
  try {
    actualContent = await readTarget(target, service, context);
  } catch (err) {
    // Read failures (NOT_FOUND etc.) are not hash mismatches — surface as
    // a normal read error so the tool's own NOT_FOUND/createIfNeeded path
    // takes over.
    throw err;
  }

  const actual = sha256(actualContent);
  if (actual === expected) {
    return;
  }

  const targetDesc =
    target.kind === "filePath"
      ? target.path
      : target.kind === "activeFile"
        ? "(active file)"
        : `(periodic ${target.period})`;

  logger.warning(
    `Hash pre-flight mismatch for ${targetDesc} — expected ${expected}, actual ${actual}. Aborting write.`,
    {
      ...context,
      operation: "preflightContentHash",
      expected_hash: expected,
      actual_hash: actual,
    },
  );

  throw new HashMismatchError(
    buildStructuredError(
      "hash_mismatch",
      `File '${targetDesc}' was modified since the caller's last read. Expected SHA-256 ${expected}, found ${actual}.`,
      {
        operation: "preflightContentHash",
        file: target.kind === "filePath" ? target.path : undefined,
        expected_hash: expected,
        actual_hash: actual,
      },
    ),
  );
}

/**
 * Variant for tools that have already fetched the file content as part of
 * their normal flow (search_replace, manage_tags, manage_frontmatter, etc.).
 * Avoids a second GET — just compares the SHA-256 of the in-hand content
 * against the caller's expectation. Same `hash_mismatch` semantics as
 * `preflightContentHash`.
 */
export function assertContentHash(
  actualContent: string,
  expectedHashHex: string | undefined,
  targetDesc: string,
  context: RequestContext,
): void {
  if (!expectedHashHex || expectedHashHex.trim().length === 0) {
    return;
  }
  const expected = expectedHashHex.trim().toLowerCase();
  const actual = sha256(actualContent);
  if (actual === expected) {
    return;
  }

  logger.warning(
    `Hash pre-flight mismatch for ${targetDesc} — expected ${expected}, actual ${actual}. Aborting write.`,
    {
      ...context,
      operation: "assertContentHash",
      expected_hash: expected,
      actual_hash: actual,
    },
  );

  throw new HashMismatchError(
    buildStructuredError(
      "hash_mismatch",
      `File '${targetDesc}' was modified since the caller's last read. Expected SHA-256 ${expected}, found ${actual}.`,
      {
        operation: "assertContentHash",
        file: targetDesc,
        expected_hash: expected,
        actual_hash: actual,
      },
    ),
  );
}

/**
 * Standard Zod schema description for the optional `expected_content_hash`
 * field. Shared so all write tools advertise the same semantics.
 */
export const expectedContentHashDescription =
  "Optional SHA-256 hex hash of the file content the caller last read. If provided and the current file's hash differs, the write is aborted with a hash_mismatch error to prevent clobbering concurrent modifications. Recompute by re-reading the file before retrying.";
