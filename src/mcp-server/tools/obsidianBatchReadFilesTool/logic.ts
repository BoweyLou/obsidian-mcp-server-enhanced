import path from "node:path";
import { z } from "zod";
import {
  NoteJson,
} from "../../../services/obsidianRestAPI/index.js";
import { VaultManager } from "../../../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  logger,
  RequestContext,
  retryWithDelay,
} from "../../../utils/index.js";

// ====================================================================================
// Schema Definitions for Input Validation
// ====================================================================================

/**
 * Zod schema for validating the input parameters of the 'obsidian_batch_read_files' tool.
 */
export const ObsidianBatchReadFilesInputSchema = z
  .object({
    /**
     * An array of vault-relative file paths to read (e.g., ["Folder/Note1.md", "Folder/Note2.md"]).
     * Each path must include the file extension. The tool attempts a case-sensitive match first,
     * then a case-insensitive fallback for each file.
     */
    filePaths: z
      .array(
        z.string().min(1, "Each filePath cannot be empty"),
      )
      .min(1, "filePaths array cannot be empty")
      .describe(
        'An array of vault-relative file paths to read (e.g., ["developer/github/tips.md", "daily/2025-01-01.md"]). Each path tries case-sensitive first, then case-insensitive fallback.',
      ),
    /**
     * The ID of the vault to read from. If not specified, uses the default vault.
     */
    vault: z
      .string()
      .optional()
      .describe(
        'The ID of the vault to read from (e.g., "personal", "work"). If not specified, uses the default vault.',
      ),
  })
  .describe(
    "Reads multiple files from the Obsidian vault in a single operation. Returns all file contents concatenated with headers showing each file path.",
  );

/**
 * TypeScript type inferred from the input schema.
 */
export type ObsidianBatchReadFilesInput = z.infer<typeof ObsidianBatchReadFilesInputSchema>;

// ====================================================================================
// Response Type Definition
// ====================================================================================

/**
 * Represents the result of reading a single file within the batch.
 */
interface BatchFileResult {
  /** The vault-relative file path (may differ from requested path if case-insensitive fallback was used). */
  filePath: string;
  /** The markdown content of the file, or null if the file could not be read. */
  content: string | null;
  /** Error message if the file could not be read. */
  error?: string;
}

/**
 * Defines the structure of the successful response returned by `processObsidianBatchReadFiles`.
 */
export interface ObsidianBatchReadFilesResponse {
  /** The concatenated content of all files with headers. */
  combinedContent: string;
  /** The number of files successfully read. */
  successCount: number;
  /** The number of files that failed to read. */
  errorCount: number;
  /** Per-file error details (only included for files that failed). */
  errors?: Array<{ filePath: string; error: string }>;
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

/**
 * Reads a single file with case-insensitive fallback, returning its content or an error.
 */
async function readSingleFile(
  filePath: string,
  obsidianService: ReturnType<VaultManager["getVaultService"]>,
  context: RequestContext,
): Promise<BatchFileResult> {
  const shouldRetryNotFound = (err: unknown) =>
    err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND;

  try {
    // Attempt 1: Case-sensitive read
    const readContext = { ...context, operation: "readFileAsJson", filePath };
    const noteJson = await retryWithDelay(
      () =>
        obsidianService.getFileContent(
          filePath,
          "json",
          readContext,
        ) as Promise<NoteJson>,
      {
        operationName: "batchReadFileWithRetry",
        context: readContext,
        maxRetries: 3,
        delayMs: 300,
        shouldRetry: shouldRetryNotFound,
      },
    );

    return {
      filePath,
      content: noteJson.content ?? "",
    };
  } catch (error) {
    // Attempt 2: Case-insensitive fallback if NOT_FOUND
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      const fallbackContext = {
        ...context,
        subOperation: "caseInsensitiveFallback",
        filePath,
      };

      try {
        const dirname = path.posix.dirname(filePath);
        const filenameLower = path.posix.basename(filePath).toLowerCase();
        const dirToList = dirname === "." ? "/" : dirname;

        const filesInDir = await retryWithDelay(
          () => obsidianService.listFiles(dirToList, fallbackContext),
          {
            operationName: "listFilesForBatchReadFallback",
            context: fallbackContext,
            maxRetries: 3,
            delayMs: 300,
            shouldRetry: shouldRetryNotFound,
          },
        );

        const matches = filesInDir.filter(
          (f) =>
            !f.endsWith("/") &&
            path.posix.basename(f).toLowerCase() === filenameLower,
        );

        if (matches.length === 1) {
          const correctFilename = path.posix.basename(matches[0]);
          const effectivePath = path.posix.join(dirname, correctFilename);

          const noteJson = await retryWithDelay(
            () =>
              obsidianService.getFileContent(
                effectivePath,
                "json",
                fallbackContext,
              ) as Promise<NoteJson>,
            {
              operationName: "batchReadFileWithFallbackRetry",
              context: fallbackContext,
              maxRetries: 3,
              delayMs: 300,
              shouldRetry: shouldRetryNotFound,
            },
          );

          return {
            filePath: effectivePath,
            content: noteJson.content ?? "",
          };
        } else if (matches.length > 1) {
          return {
            filePath,
            content: null,
            error: `Ambiguous case-insensitive matches: [${matches.join(", ")}]`,
          };
        } else {
          return {
            filePath,
            content: null,
            error: "File not found (case-insensitive fallback also failed)",
          };
        }
      } catch (fallbackError) {
        return {
          filePath,
          content: null,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        };
      }
    }

    // Non-NOT_FOUND error
    return {
      filePath,
      content: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Processes the core logic for batch reading files from the Obsidian vault.
 *
 * Reads each file in the provided array, concatenates their contents with headers
 * showing each file path, and returns a summary of successes and failures.
 *
 * @param {ObsidianBatchReadFilesInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @param {VaultManager} vaultManager - The VaultManager instance for multi-vault support.
 * @returns {Promise<ObsidianBatchReadFilesResponse>} A promise resolving to the batch read response.
 * @throws {McpError} Throws an McpError if a critical error occurs during processing.
 */
export const processObsidianBatchReadFiles = async (
  params: ObsidianBatchReadFilesInput,
  context: RequestContext,
  vaultManager: VaultManager,
): Promise<ObsidianBatchReadFilesResponse> => {
  const { filePaths, vault: vaultId } = params;

  const obsidianService = vaultManager.getVaultService(vaultId, context);
  const vaultConfig = vaultManager.getVaultConfig(vaultId);

  logger.debug(
    `Processing obsidian_batch_read_files request for ${filePaths.length} files`,
    {
      ...context,
      fileCount: filePaths.length,
      vaultId: vaultConfig.id,
      vaultName: vaultConfig.name,
    },
  );

  try {
    // Read all files concurrently
    const results = await Promise.all(
      filePaths.map((fp) => readSingleFile(fp, obsidianService, context)),
    );

    // Build concatenated content with headers
    const contentParts: string[] = [];
    const errors: Array<{ filePath: string; error: string }> = [];
    let successCount = 0;

    for (const result of results) {
      if (result.content !== null) {
        contentParts.push(`--- ${result.filePath} ---\n${result.content}`);
        successCount++;
      } else {
        contentParts.push(`--- ${result.filePath} ---\nERROR: ${result.error}`);
        errors.push({ filePath: result.filePath, error: result.error! });
      }
    }

    const response: ObsidianBatchReadFilesResponse = {
      combinedContent: contentParts.join("\n\n"),
      successCount,
      errorCount: errors.length,
    };

    if (errors.length > 0) {
      response.errors = errors;
    }

    logger.debug(
      `Batch read completed: ${successCount} succeeded, ${errors.length} failed`,
      context,
    );

    return response;
  } catch (error) {
    if (error instanceof McpError) {
      logger.error(
        `McpError during batch file read: ${error.message}`,
        error,
        context,
      );
      throw error;
    }
    const errorMessage = `Unexpected error processing batch read request`;
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
};
