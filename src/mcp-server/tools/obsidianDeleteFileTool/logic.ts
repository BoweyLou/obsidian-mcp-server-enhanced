import path from "node:path"; // node:path provides OS-specific path functions; using path.posix for vault path manipulation.
import { z } from "zod";
import {
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { VaultManager } from "../../../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  expectedContentHashDescription,
  HashMismatchError,
  logger,
  preflightContentHash,
  RequestContext,
  retryWithDelay,
  retryWithExponentialBackoff,
  verifyDeletion,
  VerificationResult,
  WriteLockTimeoutError,
  WriteRetryExhaustedError,
} from "../../../utils/index.js";

// ====================================================================================
// Schema Definitions for Input Validation
// ====================================================================================

/**
 * Zod schema for validating the input parameters of the 'obsidian_delete_file' tool.
 */
export const ObsidianDeleteFileInputSchema = z
  .object({
    /**
     * The vault-relative path to the file to be permanently deleted.
     * Must include the file extension (e.g., "Old Notes/Obsolete File.md").
     * The tool first attempts a case-sensitive match. If not found, it attempts
     * a case-insensitive fallback search within the same directory.
     */
    filePath: z
      .string()
      .min(1, "filePath cannot be empty")
      .describe(
        'The vault-relative path to the file to be deleted (e.g., "archive/old-file.md"). Tries case-sensitive first, then case-insensitive fallback.',
      ),
    /**
     * The ID of the vault to delete from. If not specified, uses the default vault.
     */
    vault: z
      .string()
      .optional()
      .describe(
        'The ID of the vault to delete from (e.g., "personal", "work"). If not specified, uses the default vault.',
      ),
    /** T1.4 — optional idempotency UUID. */
    idempotency_key: z
      .string()
      .optional()
      .describe(
        "Optional client-supplied UUID. If the same key is sent twice within 60s, the second call returns the cached result.",
      ),
    /** T2.3 — optional pre-flight hash check. */
    expected_content_hash: z
      .string()
      .optional()
      .describe(expectedContentHashDescription),
  })
  .describe(
    "Input parameters for permanently deleting a specific file within the connected Obsidian vault. Includes a case-insensitive path fallback.",
  );

/**
 * TypeScript type inferred from the input schema (`ObsidianDeleteFileInputSchema`).
 * Represents the validated input parameters used within the core processing logic.
 */
export type ObsidianDeleteFileInput = z.infer<
  typeof ObsidianDeleteFileInputSchema
>;

// ====================================================================================
// Response Type Definition
// ====================================================================================

/**
 * Defines the structure of the successful response returned by the `processObsidianDeleteFile` function.
 * This object is typically serialized to JSON and sent back to the client.
 */
export interface ObsidianDeleteFileResponse {
  /** Indicates whether the deletion operation was successful. */
  success: boolean;
  /** A human-readable message confirming the deletion and specifying the path used. */
  message: string;
  /** T1.3 — read-back verification result (file should now return 404). */
  verification?: VerificationResult;
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

/**
 * Processes the core logic for deleting a file from the Obsidian vault.
 *
 * It attempts to delete the file using the provided path (case-sensitive first).
 * If that fails with a 'NOT_FOUND' error, it attempts a case-insensitive fallback:
 * it lists the directory, finds a unique case-insensitive match for the filename,
 * and retries the deletion with the corrected path.
 *
 * @param {ObsidianDeleteFileInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @param {VaultManager} vaultManager - The VaultManager instance for multi-vault support.
 * @returns {Promise<ObsidianDeleteFileResponse>} A promise resolving to the structured success response
 *   containing a confirmation message.
 * @throws {McpError} Throws an McpError if the file cannot be found (even with fallback),
 *   if there's an ambiguous fallback match, or if any other API interaction fails.
 */
export const processObsidianDeleteFile = async (
  params: ObsidianDeleteFileInput,
  context: RequestContext,
  vaultManager: VaultManager,
): Promise<ObsidianDeleteFileResponse> => {
  const { filePath: originalFilePath, vault: vaultId } = params;

  // Get the appropriate services for the specified vault
  const obsidianService = vaultManager.getVaultService(vaultId, context);
  const vaultCacheService = vaultManager.getVaultCacheService(vaultId, context);
  const vaultConfig = vaultManager.getVaultConfig(vaultId);
  let effectiveFilePath = originalFilePath; // Track the path actually used for deletion

  logger.debug(
    `Processing obsidian_delete_file request for path: ${originalFilePath}`,
    {
      ...context,
      vaultId: vaultConfig.id,
      vaultName: vaultConfig.name,
    },
  );

  const shouldRetryNotFound = (err: unknown) =>
    err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND;

  try {
    // --- Attempt 1: Delete using the provided path (case-sensitive) ---
    const deleteContext = {
      ...context,
      operation: "deleteFileAttempt",
      caseSensitive: true,
    };
    logger.debug(
      `Attempting to delete file (case-sensitive): ${originalFilePath}`,
      deleteContext,
    );
    // T2.3: pre-flight hash check before delete. A NOT_FOUND from this read
    // falls through to the case-insensitive fallback below; a hash mismatch
    // aborts immediately.
    await preflightContentHash(
      { kind: "filePath", path: originalFilePath },
      params.expected_content_hash,
      obsidianService,
      { ...deleteContext, operation: "preflightContentHash" },
    );
    // T1.2: exponential-backoff retry on transient transport errors. NOT_FOUND
    // is intentionally non-retryable here so we fall through to the
    // case-insensitive fallback below.
    await retryWithExponentialBackoff(
      () => obsidianService.deleteFile(originalFilePath, deleteContext),
      {
        operationName: "obsidian_delete_file:primary",
        context: deleteContext,
        errorContext: { file: originalFilePath, attempt: "case-sensitive" },
      },
    );

    // If the above call succeeds, the file was deleted using the exact path.
    logger.debug(
      `Successfully deleted file using exact path: ${originalFilePath}`,
      deleteContext,
    );
    if (vaultCacheService) {
      await vaultCacheService.updateCacheForFile(
        originalFilePath,
        deleteContext,
      );
    }
    // T1.3: confirm the file is actually gone post-delete.
    const verification = await verifyDeletion(
      { kind: "filePath", path: originalFilePath },
      obsidianService,
      { ...deleteContext, operation: "verifyDeletion" },
    );
    if (!verification.verified) {
      logger.error(
        `Delete verification failed for ${originalFilePath}: ${verification.reason}`,
        undefined,
        { ...deleteContext, verification },
      );
      throw new McpError(
        BaseErrorCode.INTERNAL_ERROR,
        `File '${originalFilePath}' delete reported success but the file is still readable.`,
        { ...deleteContext, verification_error: true, reason: verification.reason },
      );
    }
    return {
      success: true,
      message: `File '${originalFilePath}' deleted successfully.`,
      verification,
    };
  } catch (error) {
    // --- Attempt 2: Case-insensitive fallback if initial delete failed with NOT_FOUND ---
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      logger.info(
        `File not found with exact path: ${originalFilePath}. Attempting case-insensitive fallback for deletion.`,
        context,
      );
      const fallbackContext = { ...context, operation: "deleteFileFallback" };

      try {
        // Use POSIX path functions for vault path manipulation
        const dirname = path.posix.dirname(originalFilePath);
        const filenameLower = path.posix
          .basename(originalFilePath)
          .toLowerCase();
        // Handle case where the file is in the vault root (dirname is '.')
        const dirToList = dirname === "." ? "/" : dirname;

        logger.debug(
          `Listing directory for fallback deletion: ${dirToList}`,
          fallbackContext,
        );
        const filesInDir = await retryWithDelay(
          () => obsidianService.listFiles(dirToList, fallbackContext),
          {
            operationName: "listFilesForDeleteFallback",
            context: fallbackContext,
            maxRetries: 3,
            delayMs: 300,
            shouldRetry: shouldRetryNotFound,
          },
        );

        // Filter directory listing for files matching the lowercase filename
        const matches = filesInDir.filter(
          (f) =>
            !f.endsWith("/") && // Ensure it's a file
            path.posix.basename(f).toLowerCase() === filenameLower,
        );

        if (matches.length === 1) {
          // Found exactly one case-insensitive match
          const correctFilename = path.posix.basename(matches[0]);
          effectiveFilePath = path.posix.join(dirname, correctFilename); // Update the path to use
          logger.info(
            `Found case-insensitive match: ${effectiveFilePath}. Retrying delete.`,
            fallbackContext,
          );

          // Retry deleting with the correctly cased path
          const retryContext = {
            ...fallbackContext,
            subOperation: "retryDelete",
            effectiveFilePath,
          };
          // T2.3: hash check against the case-corrected path before delete.
          await preflightContentHash(
            { kind: "filePath", path: effectiveFilePath },
            params.expected_content_hash,
            obsidianService,
            { ...retryContext, operation: "preflightContentHash" },
          );
          // T1.2: exponential-backoff retry on the corrected path.
          await retryWithExponentialBackoff(
            () => obsidianService.deleteFile(effectiveFilePath, retryContext),
            {
              operationName: "obsidian_delete_file:fallback",
              context: retryContext,
              errorContext: {
                file: effectiveFilePath,
                attempt: "case-insensitive",
              },
            },
          );

          logger.debug(
            `Successfully deleted file using fallback path: ${effectiveFilePath}`,
            retryContext,
          );
          if (vaultCacheService) {
            await vaultCacheService.updateCacheForFile(
              effectiveFilePath,
              retryContext,
            );
          }
          // T1.3 verify
          const fallbackVerification = await verifyDeletion(
            { kind: "filePath", path: effectiveFilePath },
            obsidianService,
            { ...retryContext, operation: "verifyDeletion" },
          );
          if (!fallbackVerification.verified) {
            throw new McpError(
              BaseErrorCode.INTERNAL_ERROR,
              `File '${effectiveFilePath}' delete reported success but the file is still readable.`,
              {
                ...retryContext,
                verification_error: true,
                reason: fallbackVerification.reason,
              },
            );
          }
          return {
            success: true,
            message: `File '${effectiveFilePath}' (found via case-insensitive match for '${originalFilePath}') deleted successfully.`,
            verification: fallbackVerification,
          };
        } else if (matches.length > 1) {
          // Ambiguous match: Multiple files match case-insensitively
          const errorMsg = `Deletion failed: Ambiguous case-insensitive matches for '${originalFilePath}'. Found: [${matches.join(", ")}]. Cannot determine which file to delete.`;
          logger.error(errorMsg, { ...fallbackContext, matches });
          // Use CONFLICT code for ambiguity, as NOT_FOUND isn't quite right anymore.
          throw new McpError(BaseErrorCode.CONFLICT, errorMsg, fallbackContext);
        } else {
          // No match found even with fallback
          const errorMsg = `Deletion failed: File not found for '${originalFilePath}' (case-insensitive fallback also failed).`;
          logger.error(errorMsg, fallbackContext);
          // Stick with NOT_FOUND as the original error reason holds.
          throw new McpError(
            BaseErrorCode.NOT_FOUND,
            errorMsg,
            fallbackContext,
          );
        }
      } catch (fallbackError) {
        // Preserve T2 structured error types so the wrapper can render them as
        // hash_mismatch / lock_timeout / retry_exhausted instead of internal_error.
        if (
          fallbackError instanceof HashMismatchError ||
          fallbackError instanceof WriteLockTimeoutError ||
          fallbackError instanceof WriteRetryExhaustedError
        ) {
          throw fallbackError;
        }
        // Catch errors specifically from the fallback logic (e.g., listFiles error, retry delete error)
        if (fallbackError instanceof McpError) {
          // Log and re-throw known errors from fallback
          logger.error(
            `McpError during fallback deletion for ${originalFilePath}: ${fallbackError.message}`,
            fallbackError,
            fallbackContext,
          );
          throw fallbackError;
        } else {
          // Wrap unexpected fallback errors
          const errorMessage = `Unexpected error during case-insensitive fallback deletion for ${originalFilePath}`;
          logger.error(
            errorMessage,
            fallbackError instanceof Error ? fallbackError : undefined,
            fallbackContext,
          );
          throw new McpError(
            BaseErrorCode.INTERNAL_ERROR,
            `${errorMessage}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            fallbackContext,
          );
        }
      }
    } else {
      // Preserve T2 structured error types so the wrapper can render them as
      // hash_mismatch / lock_timeout / retry_exhausted instead of internal_error.
      if (
        error instanceof HashMismatchError ||
        error instanceof WriteLockTimeoutError ||
        error instanceof WriteRetryExhaustedError
      ) {
        throw error;
      }
      // Re-throw errors from the initial delete attempt that were not NOT_FOUND or McpError
      if (error instanceof McpError) {
        logger.error(
          `McpError during initial delete attempt for ${originalFilePath}: ${error.message}`,
          error,
          context,
        );
        throw error;
      } else {
        const errorMessage = `Unexpected error deleting Obsidian file ${originalFilePath}`;
        logger.error(
          errorMessage,
          error instanceof Error ? error : undefined,
          context,
        );
        throw new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          `${errorMessage}: ${error instanceof Error ? error.message : String(error)}`,
          context,
        );
      }
    }
  }
};
