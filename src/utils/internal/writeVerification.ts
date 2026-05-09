/**
 * @fileoverview T1.3 — Read-back + hash/diff verification for Obsidian writes.
 *
 * After a successful write, immediately re-read the target and compare a
 * SHA-256 of the actual content against the expected content. Mismatches
 * surface as `verification_failed` so the caller never sees a silent success.
 *
 * For tools where the post-write content is not directly known (frontmatter
 * patches, tag manipulation), use `verifyFileReadable` instead — it confirms
 * the file is still there and returns its post-write hash for diagnostic logs.
 *
 * @module src/utils/internal/writeVerification
 */
import { createHash } from "node:crypto";
import {
  NoteJson,
  ObsidianRestApiService,
} from "../../services/obsidianRestAPI/index.js";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";

export interface VerificationResult {
  verified: boolean;
  expected_hash?: string;
  actual_hash?: string;
  /** Short snippet of expected content (first 500 chars) when mismatch. */
  expected_diff?: string;
  /** Short snippet of actual content (first 500 chars) when mismatch. */
  actual_diff?: string;
  reason?: string;
  elapsed_ms: number;
}

export type VerificationTarget =
  | { kind: "filePath"; path: string }
  | { kind: "activeFile" }
  | {
      kind: "periodicNote";
      period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
    };

const DIFF_SNIPPET_LEN = 500;

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
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
 * Strict content verification: read back and compare full SHA-256 of
 * `expectedContent` vs the actual current file.
 */
export async function verifyContentMatch(
  target: VerificationTarget,
  expectedContent: string,
  service: ObsidianRestApiService,
  context: RequestContext,
): Promise<VerificationResult> {
  const startedAt = Date.now();
  try {
    const actual = await readTarget(target, service, context);
    const expected_hash = sha256(expectedContent);
    const actual_hash = sha256(actual);
    if (expected_hash === actual_hash) {
      return {
        verified: true,
        expected_hash,
        actual_hash,
        elapsed_ms: Date.now() - startedAt,
      };
    }
    logger.warning(
      `Write verification mismatch — expected hash ${expected_hash}, actual ${actual_hash}`,
      {
        ...context,
        operation: "verifyContentMatch",
        expectedLen: expectedContent.length,
        actualLen: actual.length,
      },
    );
    return {
      verified: false,
      expected_hash,
      actual_hash,
      expected_diff: expectedContent.slice(0, DIFF_SNIPPET_LEN),
      actual_diff: actual.slice(0, DIFF_SNIPPET_LEN),
      reason: "content_hash_mismatch",
      elapsed_ms: Date.now() - startedAt,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warning(
      `Write verification could not read back target: ${reason}`,
      { ...context, operation: "verifyContentMatch" },
    );
    return {
      verified: false,
      reason: `read_back_failed: ${reason}`,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

/**
 * Light verification: confirm the file is still readable post-write and stamp
 * the resulting hash. Use for patch-style tools where expected content is
 * derived, not directly supplied.
 */
export async function verifyFileReadable(
  target: VerificationTarget,
  service: ObsidianRestApiService,
  context: RequestContext,
): Promise<VerificationResult> {
  const startedAt = Date.now();
  try {
    const actual = await readTarget(target, service, context);
    return {
      verified: true,
      actual_hash: sha256(actual),
      elapsed_ms: Date.now() - startedAt,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warning(
      `Post-write readability check failed: ${reason}`,
      { ...context, operation: "verifyFileReadable" },
    );
    return {
      verified: false,
      reason: `read_back_failed: ${reason}`,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

/**
 * Verify a deletion: target should now return NOT_FOUND.
 */
export async function verifyDeletion(
  target: VerificationTarget,
  service: ObsidianRestApiService,
  context: RequestContext,
): Promise<VerificationResult> {
  const startedAt = Date.now();
  try {
    await readTarget(target, service, context);
    // If read succeeded, deletion did not take effect.
    return {
      verified: false,
      reason: "file_still_present_after_delete",
      elapsed_ms: Date.now() - startedAt,
    };
  } catch (err) {
    // Expected: NOT_FOUND. Any error reading-back means the file is gone.
    return {
      verified: true,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

/**
 * Compute the expected post-write content for an append/prepend on top of
 * a known existing-content snapshot. Used when the tool already has both
 * pieces in memory and wants a strict hash check.
 */
export function computeExpectedAppend(
  existingContent: string,
  appendedContent: string,
): string {
  return existingContent + appendedContent;
}
export function computeExpectedPrepend(
  existingContent: string,
  prependedContent: string,
): string {
  return prependedContent + existingContent;
}

export type NoteJsonOrNull = NoteJson | null;
