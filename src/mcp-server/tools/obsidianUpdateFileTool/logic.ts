import { z } from "zod";
import {
  NoteJson,
  NoteStat,
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  countTokens,
  createFormattedStatWithTokenCount,
  logger,
  RequestContext,
  retryWithDelay,
} from "../../../utils/index.js";

// ====================================================================================
// Schema Definitions for Input Validation
// ====================================================================================

/** Defines the possible types of targets for the update operation. */
const TargetTypeSchema = z
  .enum(["filePath", "activeFile", "periodicNote"])
  .describe(
    "Specifies the target note: 'filePath', 'activeFile', or 'periodicNote'.",
  );

/** Defines the only allowed modification type for this tool implementation. */
const ModificationTypeSchema = z
  .literal("wholeFile")
  .describe(
    "Determines the modification strategy: must be 'wholeFile' for this tool.",
  );

/** Defines the specific whole-file operations supported. */
const WholeFileModeSchema = z
  .enum(["append", "prepend", "overwrite"])
  .describe(
    "Specifies the whole-file operation: 'append', 'prepend', or 'overwrite'.",
  );

/** Defines the valid periods for periodic notes. */
const PeriodicNotePeriodSchema = z
  .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
  .describe("Valid periods for 'periodicNote' target type.");

/**
 * Defines the depth of post-write verification performed after a modification.
 * - 'none': No post-write read-back at all (fastest, no stats).
 * - 'metadata': A lightweight metadata (HEAD) check is used to confirm the write and
 *   report stats, avoiding a full content re-fetch. Only applies to 'filePath' targets
 *   where the final content is already known in memory; otherwise behaves like 'full'.
 * - 'full': The entire file is re-fetched from the server to confirm the write and
 *   report stats/content (slowest, but most thorough).
 */
const VerifyModeSchema = z
  .enum(["none", "metadata", "full"])
  .optional()
  .default("metadata")
  .describe(
    "Post-write verification depth. 'none' skips verification entirely (fastest). 'metadata' (default) confirms the write via a lightweight metadata check and reports stats. 'full' re-reads the entire file content from the server. Falls back to 'full' behavior when the final content isn't already known in memory or for 'activeFile'/'periodicNote' targets.",
  );

/**
 * Base Zod schema containing fields common to all update operations within this tool.
 * Currently, only 'wholeFile' is supported, so this forms the basis for that mode.
 */
const BaseUpdateSchema = z.object({
  /** Specifies the type of target note. */
  targetType: TargetTypeSchema,
  /** The content to use for the modification. Must be a string for whole-file operations. */
  content: z
    .string()
    .describe(
      "The content for the modification (must be a string for whole-file operations).",
    ),
  /**
   * Identifier for the target. Required and must be a vault-relative path if targetType is 'filePath'.
   * Required and must be a valid period string (e.g., 'daily') if targetType is 'periodicNote'.
   * Not used if targetType is 'activeFile'.
   */
  targetIdentifier: z
    .string()
    .optional()
    .describe(
      "Identifier for 'filePath' (vault-relative path) or 'periodicNote' (period string). Not used for 'activeFile'.",
    ),
});

/**
 * Zod schema specifically for the 'wholeFile' modification type, extending the base schema.
 * Includes mode-specific options like createIfNeeded and overwriteIfExists.
 */
const WholeFileUpdateSchema = BaseUpdateSchema.extend({
  /** The modification type, fixed to 'wholeFile'. */
  modificationType: ModificationTypeSchema,
  /** The specific whole-file operation ('append', 'prepend', 'overwrite'). */
  wholeFileMode: WholeFileModeSchema,
  /** If true (default), creates the target file/note if it doesn't exist before applying the modification. If false, the operation fails if the target doesn't exist. */
  createIfNeeded: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), creates the target if it doesn't exist. If false, fails if target is missing.",
    ),
  /** Only relevant for 'overwrite' mode. If true, allows overwriting an existing file. If false (default) and the file exists, the 'overwrite' operation fails. */
  overwriteIfExists: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "For 'overwrite' mode: If true, allows overwriting. If false (default) and file exists, operation fails.",
    ),
  /** If true, includes the final content of the modified file in the response. Defaults to false. */
  returnContent: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, returns the final file content in the response."),
  /** Controls the depth of post-write verification. Defaults to 'metadata'. */
  verify: VerifyModeSchema,
});

// ====================================================================================
// Schema for SDK Registration (Flattened for Tool Definition)
// ====================================================================================

/**
 * Zod schema used for registering the tool with the MCP SDK (`server.tool`).
 * This schema defines the expected input structure from the client's perspective.
 * It flattens the structure slightly by making mode-specific fields optional at this stage,
 * relying on the refined schema (`ObsidianUpdateFileInputSchema`) for stricter validation
 * within the handler logic.
 */
const ObsidianUpdateFileRegistrationSchema = z
  .object({
    /** Specifies the target note: 'filePath' (requires targetIdentifier), 'activeFile' (currently open file), or 'periodicNote' (requires targetIdentifier with period like 'daily'). */
    targetType: TargetTypeSchema,
    /** The content for the modification. Must be a string for whole-file operations. */
    content: z
      .string()
      .describe("The content for the modification (must be a string)."),
    /** Identifier for the target when targetType is 'filePath' (vault-relative path, e.g., 'Notes/My File.md') or 'periodicNote' (period string: 'daily', 'weekly', etc.). Not used for 'activeFile'. */
    targetIdentifier: z
      .string()
      .optional()
      .describe(
        "Identifier for 'filePath' (path) or 'periodicNote' (period). Not used for 'activeFile'.",
      ),
    /** Determines the modification strategy: must be 'wholeFile'. */
    modificationType: ModificationTypeSchema,

    // --- WholeFile Mode Parameters (Marked optional here, refined schema enforces if modificationType is 'wholeFile') ---
    /** For 'wholeFile' mode: 'append', 'prepend', or 'overwrite'. Required if modificationType is 'wholeFile'. */
    wholeFileMode: WholeFileModeSchema.optional() // Made optional here, refined schema handles requirement
      .describe(
        "For 'wholeFile' mode: 'append', 'prepend', or 'overwrite'. Required if modificationType is 'wholeFile'.",
      ),
    /** For 'wholeFile' mode: If true (default), creates the target file/note if it doesn't exist before modifying. If false, fails if the target doesn't exist. */
    createIfNeeded: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "For 'wholeFile' mode: If true (default), creates target if needed. If false, fails if missing.",
      ),
    /** For 'wholeFile' mode with 'overwrite': If false (default), the operation fails if the target file already exists. If true, allows overwriting the existing file. */
    overwriteIfExists: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "For 'wholeFile'/'overwrite' mode: If false (default), fails if target exists. If true, allows overwrite.",
      ),
    /** If true, returns the final content of the file in the response. Defaults to false. */
    returnContent: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, returns the final file content in the response."),
    /** Controls the depth of post-write verification. Defaults to 'metadata'. */
    verify: VerifyModeSchema,
  })
  .describe(
    "Tool to modify Obsidian notes (specified by file path, active file, or periodic note) using whole-file operations: 'append', 'prepend', or 'overwrite'. Options control creation and overwrite behavior, and 'verify' controls post-write verification depth.",
  );

/**
 * The shape of the registration schema, used by `server.tool` for basic validation.
 * @see ObsidianUpdateFileRegistrationSchema
 */
export const ObsidianUpdateFileInputSchemaShape =
  ObsidianUpdateFileRegistrationSchema.shape;

/**
 * TypeScript type inferred from the registration schema. Represents the raw input
 * received by the tool handler *before* refinement.
 * @see ObsidianUpdateFileRegistrationSchema
 */
export type ObsidianUpdateFileRegistrationInput = z.infer<
  typeof ObsidianUpdateFileRegistrationSchema
>;

// ====================================================================================
// Refined Schema for Internal Logic and Strict Validation
// ====================================================================================

/**
 * Refined Zod schema used internally within the tool's logic for strict validation.
 * It builds upon `WholeFileUpdateSchema` and adds cross-field validation rules using `.refine()`.
 * This ensures that `targetIdentifier` is provided and valid when required by `targetType`.
 */
export const ObsidianUpdateFileInputSchema = WholeFileUpdateSchema.refine(
  (data) => {
    // Rule 1: If targetType is 'filePath' or 'periodicNote', targetIdentifier must be provided.
    if (
      (data.targetType === "filePath" || data.targetType === "periodicNote") &&
      !data.targetIdentifier
    ) {
      return false;
    }
    // Rule 2: If targetType is 'periodicNote', targetIdentifier must be a valid period string.
    if (
      data.targetType === "periodicNote" &&
      data.targetIdentifier &&
      !PeriodicNotePeriodSchema.safeParse(data.targetIdentifier).success
    ) {
      return false;
    }
    // All checks passed
    return true;
  },
  {
    // Custom error message for refinement failure.
    message:
      "targetIdentifier is required and must be a valid path for targetType 'filePath', or a valid period ('daily', 'weekly', etc.) for targetType 'periodicNote'.",
    path: ["targetIdentifier"], // Associate the error with the targetIdentifier field.
  },
);

/**
 * TypeScript type inferred from the *refined* input schema (`ObsidianUpdateFileInputSchema`).
 * This type represents the validated and structured input used within the core processing logic.
 */
export type ObsidianUpdateFileInput = z.infer<
  typeof ObsidianUpdateFileInputSchema
>;

// ====================================================================================
// Response Type Definition
// ====================================================================================

/**
 * Represents the structure of file statistics after formatting, including
 * human-readable timestamps and an estimated token count.
 */
type FormattedStat = {
  /**
   * Creation time formatted as a standard date-time string.
   * Omitted when the REST API does not expose timestamps for the verification
   * method used (e.g. HEAD-based 'metadata' verification on plugin versions
   * that do not send x-obsidian-ctime/mtime headers).
   */
  createdTime?: string;
  /** Last modified time formatted as a standard date-time string. Omitted when unavailable (see createdTime). */
  modifiedTime?: string;
  /** Estimated token count of the file content (using tiktoken 'gpt-4o'). */
  tokenCountEstimate: number;
};

/**
 * Defines the structure of the successful response returned by the `processObsidianUpdateFile` function.
 * This object is typically serialized to JSON and sent back to the client.
 */
export interface ObsidianUpdateFileResponse {
  /** Indicates whether the operation was successful. */
  success: boolean;
  /** A human-readable message describing the outcome of the operation. */
  message: string;
  /** Optional file statistics (creation/modification times, token count) if the file could be read after the update. */
  stats?: FormattedStat; // Renamed from stat
  /** Optional final content of the file, included only if `returnContent` was true in the request and the file could be read. */
  finalContent?: string;
}

// ====================================================================================
// Helper Functions
// ====================================================================================

/**
 * Attempts to retrieve the final state (content and stats) of the target note after an update operation.
 * Uses the appropriate Obsidian API method based on the target type.
 * Logs a warning and returns null if fetching the final state fails, to avoid failing the entire update operation.
 *
 * @param {z.infer<typeof TargetTypeSchema>} targetType - The type of the target note.
 * @param {string | undefined} targetIdentifier - The identifier (path or period) if applicable.
 * @param {z.infer<typeof PeriodicNotePeriodSchema> | undefined} period - The parsed period if targetType is 'periodicNote'.
 * @param {ObsidianRestApiService} obsidianService - The Obsidian API service instance.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @returns {Promise<NoteJson | null>} A promise resolving to the NoteJson object or null if retrieval fails.
 */
async function getFinalState(
  targetType: z.infer<typeof TargetTypeSchema>,
  targetIdentifier: string | undefined,
  period: z.infer<typeof PeriodicNotePeriodSchema> | undefined,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<NoteJson | null> {
  const operation = "getFinalState";
  logger.debug(
    `Attempting to retrieve final state for target: ${targetType} ${targetIdentifier ?? "(active)"}`,
    { ...context, operation },
  );
  try {
    let noteJson: NoteJson | null = null;
    // Call the appropriate API method based on target type
    if (targetType === "filePath" && targetIdentifier) {
      noteJson = (await obsidianService.getFileContent(
        targetIdentifier,
        "json",
        context,
      )) as NoteJson;
    } else if (targetType === "activeFile") {
      noteJson = (await obsidianService.getActiveFile(
        "json",
        context,
      )) as NoteJson;
    } else if (targetType === "periodicNote" && period) {
      noteJson = (await obsidianService.getPeriodicNote(
        period,
        "json",
        context,
      )) as NoteJson;
    }
    logger.debug(`Successfully retrieved final state`, {
      ...context,
      operation,
    });
    return noteJson;
  } catch (error) {
    // Log the error but don't let it fail the main update operation.
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warning(
      `Could not retrieve final state after update for target: ${targetType} ${targetIdentifier ?? "(active)"}. Error: ${errorMsg}`,
      { ...context, operation, error: errorMsg },
    );
    return null; // Return null to indicate failure without throwing
  }
}

/**
 * Attempts to retrieve just the lightweight metadata (stat) of a 'filePath' target after an
 * update, using a HEAD request instead of a full content re-fetch. This backs the 'metadata'
 * verification mode, which is much cheaper than 'full' when the final content is already
 * known in memory.
 *
 * The underlying `getFileMetadata` service call never throws (it swallows errors and resolves
 * to `null`), so this wrapper re-throws a retryable error on a `null` result to allow
 * `retryWithDelay` to apply the same backoff/retry semantics used elsewhere in this tool.
 *
 * @param {string} filePath - The vault-relative path of the file to check.
 * @param {ObsidianRestApiService} obsidianService - The Obsidian API service instance.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @returns {Promise<NoteStat | null>} A promise resolving to the file's metadata, or `null` if
 *   it could not be retrieved after retries.
 */
async function getFinalMetadata(
  filePath: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<NoteStat | null> {
  const operation = "getFinalMetadata";
  try {
    return await retryWithDelay(
      async () => {
        const stat = await obsidianService.getFileMetadata(filePath, context);
        if (stat === null) {
          // Force a retryable failure so retryWithDelay's backoff kicks in.
          throw new McpError(
            BaseErrorCode.NOT_FOUND,
            `Metadata not yet available for '${filePath}' after update.`,
            { ...context, operation },
          );
        }
        return stat;
      },
      {
        operationName: "getFileMetadataAfterUpdate",
        context: { ...context, operation: "getFileMetadataAfterUpdateAttempt" },
        maxRetries: 3, // Total attempts: 1 initial + 2 retries
        delayMs: 250,
        shouldRetry: (error: unknown) =>
          error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND,
        onRetry: (attempt, error) => {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          logger.warning(
            `getFinalMetadata (attempt ${attempt}) failed for '${filePath}'. Error: ${errorMsg}. Retrying...`,
            { ...context, operation: "getFinalMetadataRetry" },
          );
        },
      },
    );
  } catch (error) {
    // All retries exhausted (or an unexpected error occurred); do not fail the main operation.
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warning(
      `Could not retrieve final metadata after update for '${filePath}'. Error: ${errorMsg}`,
      { ...context, operation, error: errorMsg },
    );
    return null;
  }
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

/**
 * Processes the core logic for the 'obsidian_update_file' tool when using the 'wholeFile'
 * modification type (append, prepend, overwrite). It handles pre-checks, performs the
 * update via the Obsidian REST API, retrieves the final state, and constructs the response.
 *
 * @param {ObsidianUpdateFileInput} params - The validated input parameters conforming to the refined schema.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @param {ObsidianRestApiService} obsidianService - The instance of the Obsidian REST API service.
 * @returns {Promise<ObsidianUpdateFileResponse>} A promise resolving to the structured success response.
 * @throws {McpError} Throws an McpError if validation fails or the API interaction results in an error.
 */
export const processObsidianUpdateFile = async (
  params: ObsidianUpdateFileInput, // Use the refined, validated type
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<ObsidianUpdateFileResponse> => {
  logger.debug(`Processing obsidian_update_file request (wholeFile mode)`, {
    ...context,
    targetType: params.targetType,
    wholeFileMode: params.wholeFileMode,
  });

  const targetId = params.targetIdentifier; // Alias for clarity
  const contentString = params.content;
  const mode = params.wholeFileMode;
  let wasCreated = false; // Flag to track if the file was newly created by the operation
  let targetPeriod: z.infer<typeof PeriodicNotePeriodSchema> | undefined;
  // Tracks the exact content written to the target and whether it is fully known in memory
  // (as opposed to needing a re-fetch to determine). This drives the 'metadata' verify mode
  // and the cheap, fetch-free cache update path.
  let writtenContent = "";
  let finalContentKnown = false;

  // Parse the period if the target is a periodic note
  if (params.targetType === "periodicNote" && targetId) {
    // Use safeParse for robustness, though refined schema should guarantee validity
    const parseResult = PeriodicNotePeriodSchema.safeParse(targetId);
    if (!parseResult.success) {
      // This should ideally not happen due to the refined schema, but handle defensively
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Invalid period provided for periodicNote: ${targetId}`,
        context,
      );
    }
    targetPeriod = parseResult.data;
  }

  try {
    // --- Step 1: Pre-operation Existence Check ---
    // Determine if the target file/note exists before attempting modification.
    // This is crucial for overwrite safety checks and createIfNeeded logic.
    let existsBefore = false;
    const checkContext = { ...context, operation: "existenceCheck" };
    logger.debug(
      `Checking existence of target: ${params.targetType} ${targetId ?? "(active)"}`,
      checkContext,
    );

    try {
      await retryWithDelay(
        async () => {
          if (params.targetType === "filePath" && targetId) {
            await obsidianService.getFileContent(
              targetId,
              "json",
              checkContext,
            );
          } else if (params.targetType === "activeFile") {
            await obsidianService.getActiveFile("json", checkContext);
          } else if (params.targetType === "periodicNote" && targetPeriod) {
            await obsidianService.getPeriodicNote(
              targetPeriod,
              "json",
              checkContext,
            );
          }
          // If any of the above succeed without throwing, the target exists.
          existsBefore = true;
          logger.debug(`Target exists before operation.`, checkContext);
        },
        {
          operationName: "existenceCheckObsidianUpdateFile",
          context: checkContext,
          maxRetries: 3, // Total attempts: 1 initial + 2 retries
          delayMs: 250,
          shouldRetry: (error: unknown) => {
            // Only retry if it's a NOT_FOUND error AND createIfNeeded is true.
            // If createIfNeeded is false, a NOT_FOUND error means we shouldn't proceed, so don't retry.
            const should =
              error instanceof McpError &&
              error.code === BaseErrorCode.NOT_FOUND &&
              params.createIfNeeded;
            if (
              error instanceof McpError &&
              error.code === BaseErrorCode.NOT_FOUND
            ) {
              logger.debug(
                `existenceCheckObsidianUpdateFile: shouldRetry=${should} for NOT_FOUND (createIfNeeded: ${params.createIfNeeded})`,
                checkContext,
              );
            }
            return should;
          },
          onRetry: (attempt, error) => {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            logger.warning(
              `Existence check (attempt ${attempt}) failed for target '${params.targetType} ${targetId ?? ""}'. Error: ${errorMsg}. Retrying as createIfNeeded is true...`,
              checkContext,
            );
          },
        },
      );
    } catch (error) {
      // This catch block is primarily for the case where retryWithDelay itself throws
      // (e.g., all retries exhausted for NOT_FOUND with createIfNeeded=true, or an unretryable error occurred).
      if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
        // If it's still NOT_FOUND after retries (or if createIfNeeded was false and it failed the first time),
        // then existsBefore should definitely be false.
        existsBefore = false;
        logger.debug(
          `Target confirmed not to exist after existence check attempts (createIfNeeded: ${params.createIfNeeded}).`,
          checkContext,
        );
      } else {
        // For any other error type, re-throw it as it's unexpected here.
        logger.error(
          `Unexpected error after existence check retries`,
          error instanceof Error ? error : undefined,
          checkContext,
        );
        throw error;
      }
    }

    // --- Step 2: Perform Safety and Configuration Checks ---
    const safetyCheckContext = {
      ...context,
      operation: "safetyChecks",
      existsBefore,
    };

    // Check 2a: Overwrite safety
    if (mode === "overwrite" && existsBefore && !params.overwriteIfExists) {
      logger.warning(
        `Overwrite attempt failed: Target exists and overwriteIfExists is false.`,
        safetyCheckContext,
      );
      throw new McpError(
        BaseErrorCode.CONFLICT, // Use CONFLICT as it clashes with existing state + config
        `Target ${params.targetType} '${targetId ?? "(active)"}' exists, and 'overwriteIfExists' is set to false. Cannot overwrite.`,
        safetyCheckContext,
      );
    }

    // Check 2b: Not Found when creation is disabled
    if (!existsBefore && !params.createIfNeeded) {
      logger.warning(
        `Update attempt failed: Target not found and createIfNeeded is false.`,
        safetyCheckContext,
      );
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        `Target ${params.targetType} '${targetId ?? "(active)"}' not found, and 'createIfNeeded' is set to false. Cannot update.`,
        safetyCheckContext,
      );
    }

    // Determine if the operation will result in file creation
    wasCreated = !existsBefore && params.createIfNeeded;
    logger.debug(
      `Operation will proceed. File creation needed: ${wasCreated}`,
      safetyCheckContext,
    );

    // --- Step 3: Perform the Update Operation via Obsidian API ---
    const updateContext = {
      ...context,
      operation: `performUpdate:${mode}`,
      wasCreated,
    };
    logger.debug(`Performing update operation: ${mode}`, updateContext);

    // Handle 'prepend' and 'append' manually as Obsidian API might not directly support them atomically.
    if (mode === "prepend" || mode === "append") {
      let existingContent = "";
      // Only read existing content if the file existed before the operation.
      if (existsBefore) {
        const readContext = { ...updateContext, subOperation: "readForModify" };
        logger.debug(`Reading existing content for ${mode}`, readContext);
        try {
          if (params.targetType === "filePath" && targetId) {
            existingContent = (await obsidianService.getFileContent(
              targetId,
              "markdown",
              readContext,
            )) as string;
          } else if (params.targetType === "activeFile") {
            existingContent = (await obsidianService.getActiveFile(
              "markdown",
              readContext,
            )) as string;
          } else if (params.targetType === "periodicNote" && targetPeriod) {
            existingContent = (await obsidianService.getPeriodicNote(
              targetPeriod,
              "markdown",
              readContext,
            )) as string;
          }
          logger.debug(
            `Successfully read existing content. Length: ${existingContent.length}`,
            readContext,
          );
        } catch (readError) {
          // This should ideally not happen if existsBefore is true, but handle defensively.
          const errorMsg =
            readError instanceof Error ? readError.message : String(readError);
          logger.error(
            `Error reading existing content for ${mode} despite existence check.`,
            readError instanceof Error ? readError : undefined,
            readContext,
          );
          throw new McpError(
            BaseErrorCode.INTERNAL_ERROR,
            `Failed to read existing content for ${mode} operation. Error: ${errorMsg}`,
            readContext,
          );
        }
      } else {
        logger.debug(
          `Target did not exist before, skipping read for ${mode}.`,
          updateContext,
        );
      }

      // Combine content based on the mode.
      const newContent =
        mode === "prepend"
          ? contentString + existingContent
          : existingContent + contentString;
      logger.debug(
        `Combined content length for ${mode}: ${newContent.length}`,
        updateContext,
      );
      // The final content is fully composed in memory before writing, so it's always known.
      writtenContent = newContent;
      finalContentKnown = true;

      // Overwrite the target with the newly combined content.
      const writeContext = { ...updateContext, subOperation: "writeCombined" };
      logger.debug(`Writing combined content back to target`, writeContext);
      if (params.targetType === "filePath" && targetId) {
        await obsidianService.updateFileContent(
          targetId,
          newContent,
          writeContext,
        );
      } else if (params.targetType === "activeFile") {
        await obsidianService.updateActiveFile(newContent, writeContext);
      } else if (params.targetType === "periodicNote" && targetPeriod) {
        await obsidianService.updatePeriodicNote(
          targetPeriod,
          newContent,
          writeContext,
        );
      }
      logger.debug(
        `Successfully wrote combined content for ${mode}`,
        writeContext,
      );
    } else {
      // Handle 'overwrite' mode directly.
      // The final content is exactly the input content, so it's always known.
      writtenContent = contentString;
      finalContentKnown = true;
      switch (params.targetType) {
        case "filePath":
          // targetId is guaranteed by refined schema check
          await obsidianService.updateFileContent(
            targetId!,
            contentString,
            updateContext,
          );
          break;
        case "activeFile":
          await obsidianService.updateActiveFile(contentString, updateContext);
          break;
        case "periodicNote":
          // targetPeriod is guaranteed by refined schema check
          await obsidianService.updatePeriodicNote(
            targetPeriod!,
            contentString,
            updateContext,
          );
          break;
      }
      logger.debug(
        `Successfully performed overwrite on target: ${params.targetType} ${targetId ?? "(active)"}`,
        updateContext,
      );
    }

    // --- Step 4: Post-Write Verification (Stat and Optional Content) ---
    // Determine the effective verification mode for this call. 'metadata' only applies to
    // 'filePath' targets where the final content is already known in memory; otherwise it
    // falls back to 'full'. 'none' and 'full' are always honored as requested.
    const requestedVerify = params.verify;
    const effectiveVerify: "none" | "metadata" | "full" =
      requestedVerify !== "metadata"
        ? requestedVerify
        : params.targetType === "filePath" && finalContentKnown
          ? "metadata"
          : "full";
    logger.debug(
      `Resolved verification mode: requested='${requestedVerify}', effective='${effectiveVerify}'`,
      { ...context, operation: "resolveVerifyMode" },
    );

    // Outputs populated by whichever verification path runs below.
    let finalState: NoteJson | null = null; // Only populated in 'full' mode
    let stats: FormattedStat | undefined;
    let finalContentForResponse: string | undefined;
    let verificationNote: string | undefined; // Appended to the success message, if any
    let cacheMtime: number | undefined; // Known only when verification yields a fresh mtime
    let cacheContent: string = writtenContent; // Best-known content to seed the cache with

    if (effectiveVerify === "none") {
      // Fastest path: no post-write read-back whatsoever.
      logger.debug(
        `Skipping post-write verification (verify=none) for target: ${params.targetType} ${targetId ?? "(active)"}`,
        { ...context, operation: "verifyNone" },
      );
      verificationNote = " (Verification skipped as requested.)";
      if (params.returnContent) {
        if (finalContentKnown) {
          finalContentForResponse = writtenContent;
        } else {
          // Only fetch when the content truly isn't known in memory.
          const fetched = await getFinalState(
            params.targetType,
            targetId,
            targetPeriod,
            obsidianService,
            context,
          );
          finalContentForResponse = fetched?.content;
        }
      }
    } else if (effectiveVerify === "metadata") {
      // Cheap path: confirm the write via a HEAD request instead of a full content re-fetch.
      const stat = await getFinalMetadata(targetId!, obsidianService, context);
      if (stat && stat.mtime > 0) {
        const formattedStatResult = await createFormattedStatWithTokenCount(
          stat,
          writtenContent,
          context,
        );
        stats = formattedStatResult === null ? undefined : formattedStatResult;
        cacheMtime = stat.mtime;
        cacheContent = writtenContent;
      } else if (stat) {
        // HEAD succeeded (write verified) but the plugin did not send
        // x-obsidian-mtime/ctime headers, so real timestamps are unavailable.
        // Report what we truly know (token estimate from in-memory content)
        // rather than fabricating epoch-zero timestamps. Leave cacheMtime
        // unset so the cache falls back to the background full refresh,
        // which obtains the real mtime.
        try {
          stats = {
            tokenCountEstimate: await countTokens(writtenContent, context),
          };
        } catch (tokenError) {
          logger.warning(
            `Could not estimate token count for verified write: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
            context,
          );
        }
      } else {
        verificationNote =
          " (Warning: Could not retrieve final file stats/content after update.)";
      }
      if (params.returnContent) {
        // Content is already known in memory regardless of whether the metadata check succeeded.
        finalContentForResponse = writtenContent;
      }
    } else {
      // 'full' mode (either requested directly, or as a fallback): re-fetch the entire file.
      try {
        finalState = await retryWithDelay(
          async () =>
            getFinalState(
              params.targetType,
              targetId,
              targetPeriod,
              obsidianService,
              context,
            ),
          {
            operationName: "getFinalStateAfterUpdate",
            context: {
              ...context,
              operation: "getFinalStateAfterUpdateAttempt",
            }, // Use a distinct context for retry logs
            maxRetries: 3, // Total attempts: 1 initial + 2 retries
            delayMs: 250, // Shorter delay
            shouldRetry: (error: unknown) => {
              // Retry on common transient issues or if the file might not be immediately available
              const should =
                error instanceof McpError &&
                (error.code === BaseErrorCode.NOT_FOUND || // File might not be indexed immediately
                  error.code === BaseErrorCode.SERVICE_UNAVAILABLE || // API temporarily busy
                  error.code === BaseErrorCode.TIMEOUT); // API call timed out
              if (should) {
                logger.debug(
                  `getFinalStateAfterUpdate: shouldRetry=true for error code ${(error as McpError).code}`,
                  context,
                );
              }
              return should;
            },
            onRetry: (attempt, error) => {
              const errorMsg =
                error instanceof Error ? error.message : String(error);
              logger.warning(
                `getFinalState (attempt ${attempt}) failed. Error: ${errorMsg}. Retrying...`,
                { ...context, operation: "getFinalStateRetry" },
              );
            },
          },
        );
      } catch (error) {
        // If retryWithDelay throws after all attempts, getFinalState effectively failed.
        // The original getFinalState already logs a warning and returns null if it encounters an error internally
        // and is designed not to let its failure stop the main operation.
        // So, if retryWithDelay throws, it means even retries didn't help.
        finalState = null; // Ensure finalState remains null
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to retrieve final state for target '${params.targetType} ${targetId ?? ""}' even after retries. Error: ${errorMsg}`,
          error instanceof Error ? error : undefined,
          context,
        );
        // Do not re-throw here, allow the main process to construct a response with a warning.
      }

      if (finalState === null) {
        verificationNote =
          " (Warning: Could not retrieve final file stats/content after update.)";
      } else {
        const finalContentForStat = finalState.content ?? "";
        const formattedStatResult = finalState.stat
          ? await createFormattedStatWithTokenCount(
              finalState.stat,
              finalContentForStat,
              context,
            )
          : undefined;
        stats = formattedStatResult === null ? undefined : formattedStatResult;
        cacheMtime = finalState.stat?.mtime;
        cacheContent = finalState.content ?? writtenContent;
      }
      if (params.returnContent) {
        finalContentForResponse = finalState?.content;
      }
    }

    // --- Step 4b: Cache Update (filePath targets only) ---
    // Prefer a synchronous, fetch-free cache set when we have both the exact final content and
    // a fresh mtime from verification. Otherwise, fall back to a fire-and-forget refresh so the
    // response is never delayed waiting on cache consistency.
    if (params.targetType === "filePath" && targetId && vaultCacheService) {
      if (finalContentKnown && cacheMtime !== undefined) {
        vaultCacheService.setCacheEntry(
          targetId,
          cacheContent,
          cacheMtime,
          context,
        );
      } else {
        vaultCacheService.updateCacheForFile(targetId, context).catch((err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.warning(
            `Fire-and-forget cache update failed for '${targetId}': ${errorMsg}`,
            { ...context, operation: "fireAndForgetCacheUpdate" },
          );
        });
      }
    }

    // --- Step 5: Construct Success Message ---
    // Create a user-friendly message indicating what happened.
    let messageAction: string;
    if (wasCreated) {
      // Use past tense for creation events
      messageAction =
        mode === "overwrite" ? "created" : `${mode}d (and created)`;
    } else {
      // Use past tense for modifications of existing files
      messageAction = mode === "overwrite" ? "overwritten" : `${mode}ed`;
    }
    const targetName =
      params.targetType === "filePath"
        ? `'${targetId}'`
        : params.targetType === "periodicNote"
          ? `'${targetId}' note`
          : "the active file";
    let successMessage = `File content successfully ${messageAction} for ${targetName}.`; // Use let
    logger.info(successMessage, context); // Log initial success message

    // Append a verification note, if any (either a skip notice or a failure warning).
    if (verificationNote) {
      successMessage += verificationNote;
      const isWarning = verificationNote.startsWith(" (Warning");
      if (isWarning) {
        logger.warning(
          `Appending warning to response message: ${verificationNote}`,
          context,
        );
      } else {
        logger.debug(
          `Appending note to response message: ${verificationNote}`,
          context,
        );
      }
    }

    // --- Step 6: Build and Return Response ---
    // Construct the final response object using the stats gathered by the verification step above.
    const response: ObsidianUpdateFileResponse = {
      success: true,
      message: successMessage,
      stats,
    };

    // Include final content if requested and available.
    if (params.returnContent) {
      response.finalContent = finalContentForResponse; // Assign content if available, otherwise undefined
      logger.debug(
        `Including final content in response as requested.`,
        context,
      );
    }

    return response;
  } catch (error) {
    // Handle errors, ensuring they are McpError instances before re-throwing.
    // Errors from obsidianService calls should already be McpErrors and logged by the service.
    if (error instanceof McpError) {
      // Log McpErrors specifically from this level if needed, though lower levels might have logged already
      logger.error(
        `McpError during file update: ${error.message}`,
        error,
        context,
      );
      throw error; // Re-throw known McpError
    } else {
      // Catch unexpected errors, log them, and wrap in a generic McpError.
      const errorMessage = `Unexpected error updating Obsidian file/note`;
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
};
