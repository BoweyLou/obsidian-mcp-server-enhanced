import { z } from "zod";
import {
  NoteJson,
  ObsidianRestApiService,
} from "../../../services/obsidianRestAPI/index.js";
import { VaultManager } from "../../../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  createFormattedStatWithTokenCount,
  expectedContentHashDescription,
  HashMismatchError,
  logger,
  preflightContentHash,
  RequestContext,
  retryWithDelay,
  retryWithExponentialBackoff,
  verifyContentMatch,
  VerificationResult,
  VerificationTarget,
  WriteLockTimeoutError,
  WriteRetryExhaustedError,
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
  /**
   * The ID of the vault to write to. If not specified, uses the default vault.
   */
  vault: z
    .string()
    .optional()
    .describe(
      'The ID of the vault to write to (e.g., "personal", "work"). If not specified, uses the default vault.',
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
  /** T2.3 — optional pre-flight hash check. Mirrors the registration schema so it survives refined parsing. */
  expected_content_hash: z
    .string()
    .optional()
    .describe(expectedContentHashDescription),
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
    /** The ID of the vault to write to. If not specified, uses the default vault. */
    vault: z
      .string()
      .optional()
      .describe(
        'The ID of the vault to write to (e.g., "personal", "work"). If not specified, uses the default vault.',
      ),
    /** T1.4 — optional idempotency UUID. */
    idempotency_key: z
      .string()
      .optional()
      .describe(
        "Optional client-supplied UUID. If the same key is sent twice within 60s, the second call is a no-op and returns the cached result. Closes delete+rewrite race conditions on retry.",
      ),
    /** T2.3 — optional pre-flight hash check. */
    expected_content_hash: z
      .string()
      .optional()
      .describe(expectedContentHashDescription),
  })
  .describe(
    "Tool to modify Obsidian notes (specified by file path, active file, or periodic note) using whole-file operations: 'append', 'prepend', or 'overwrite'. Options control creation and overwrite behavior.",
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
  /** Creation time formatted as a standard date-time string. */
  createdTime: string;
  /** Last modified time formatted as a standard date-time string. */
  modifiedTime: string;
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
  /** T1.3 — read-back hash verification result. */
  verification?: VerificationResult;
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
  vaultManager: VaultManager,
): Promise<ObsidianUpdateFileResponse> => {
  const obsidianService = vaultManager.getVaultService(params.vault, context);
  const vaultCacheService = vaultManager.getVaultCacheService(
    params.vault,
    context,
  );
  const vaultConfig = vaultManager.getVaultConfig(params.vault);

  logger.debug(`Processing obsidian_update_file request (wholeFile mode)`, {
    ...context,
    targetType: params.targetType,
    wholeFileMode: params.wholeFileMode,
    vaultId: vaultConfig.id,
    vaultName: vaultConfig.name,
  });

  const targetId = params.targetIdentifier; // Alias for clarity
  const contentString = params.content;
  const mode = params.wholeFileMode;
  let wasCreated = false; // Flag to track if the file was newly created by the operation
  let targetPeriod: z.infer<typeof PeriodicNotePeriodSchema> | undefined;
  // T1.3 — capture what the file content should be after the write so we can hash-verify.
  let expectedPostWriteContent: string | undefined;

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

    // --- T2.3: Pre-flight hash check (only when modifying existing content) ---
    // If the file is being created fresh, there is no prior content to hash
    // against, so the check is meaningfully a no-op even if the caller passed
    // a hash.
    if (existsBefore && params.expected_content_hash) {
      const preflightTarget: VerificationTarget =
        params.targetType === "filePath" && targetId
          ? { kind: "filePath", path: targetId }
          : params.targetType === "activeFile"
            ? { kind: "activeFile" }
            : { kind: "periodicNote", period: targetPeriod! };
      await preflightContentHash(
        preflightTarget,
        params.expected_content_hash,
        obsidianService,
        { ...context, operation: "preflightContentHash" },
      );
    }

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

      // Overwrite the target with the newly combined content.
      // T1.2: wrap the API write in exponential-backoff retry (1s/2s/4s).
      const writeContext = { ...updateContext, subOperation: "writeCombined" };
      logger.debug(`Writing combined content back to target`, writeContext);
      await retryWithExponentialBackoff(
        async () => {
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
        },
        {
          operationName: `obsidian_update_file:${mode}`,
          context: writeContext,
          errorContext: {
            file: targetId ?? params.targetType,
            mode,
          },
        },
      );
      expectedPostWriteContent = newContent;
      logger.debug(
        `Successfully wrote combined content for ${mode}`,
        writeContext,
      );
      if (params.targetType === "filePath" && targetId && vaultCacheService) {
        await vaultCacheService.updateCacheForFile(targetId, writeContext);
      }
    } else {
      // Handle 'overwrite' mode directly. T1.2: wrap in exponential-backoff retry.
      await retryWithExponentialBackoff(
        async () => {
          switch (params.targetType) {
            case "filePath":
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
              await obsidianService.updatePeriodicNote(
                targetPeriod!,
                contentString,
                updateContext,
              );
              break;
          }
        },
        {
          operationName: `obsidian_update_file:overwrite`,
          context: updateContext,
          errorContext: {
            file: targetId ?? params.targetType,
            mode: "overwrite",
          },
        },
      );
      expectedPostWriteContent = contentString;
      logger.debug(
        `Successfully performed overwrite on target: ${params.targetType} ${targetId ?? "(active)"}`,
        updateContext,
      );
      if (params.targetType === "filePath" && targetId && vaultCacheService) {
        await vaultCacheService.updateCacheForFile(targetId, updateContext);
      }
    }

    // --- Step 4: Get Final State (Stat and Optional Content) ---
    // Add a small delay before attempting to get the final state, to allow Obsidian API to stabilize after write.
    const POST_UPDATE_DELAY_MS = 250;
    logger.debug(
      `Waiting ${POST_UPDATE_DELAY_MS}ms before retrieving final state...`,
      { ...context, operation: "postUpdateDelay" },
    );
    await new Promise((resolve) => setTimeout(resolve, POST_UPDATE_DELAY_MS));

    // Attempt to retrieve the file's state *after* the modification.
    let finalState: NoteJson | null = null; // Initialize to null
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
          context: { ...context, operation: "getFinalStateAfterUpdateAttempt" }, // Use a distinct context for retry logs
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

    // --- Step 4b: T1.3 Read-back hash verification ---
    let verification: VerificationResult | undefined;
    if (expectedPostWriteContent !== undefined) {
      const verifyTarget: VerificationTarget =
        params.targetType === "filePath" && targetId
          ? { kind: "filePath", path: targetId }
          : params.targetType === "activeFile"
            ? { kind: "activeFile" }
            : { kind: "periodicNote", period: targetPeriod! };
      verification = await verifyContentMatch(
        verifyTarget,
        expectedPostWriteContent,
        obsidianService,
        { ...context, operation: "verifyContentMatch" },
      );
      if (!verification.verified) {
        logger.error(
          `Write verification failed for ${params.targetType} ${targetId ?? "(active)"} (reason=${verification.reason})`,
          undefined,
          { ...context, operation: "verifyContentMatch", verification },
        );
        // Throw McpError so the wrapper turns this into a structured
        // "verification_failed" response. No silent successes.
        throw new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          `Write reported success but read-back verification failed: ${verification.reason}`,
          {
            ...context,
            verification_error: true,
            expected_hash: verification.expected_hash,
            actual_hash: verification.actual_hash,
            reason: verification.reason,
          },
        );
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

    // Append a warning if the final state couldn't be retrieved
    if (finalState === null) {
      const warningMsg =
        " (Warning: Could not retrieve final file stats/content after update.)";
      successMessage += warningMsg;
      logger.warning(
        `Appending warning to response message: ${warningMsg}`,
        context,
      );
    }

    // --- Step 6: Build and Return Response ---
    // Format the file statistics (if available) using the shared utility.
    const finalContentForStat = finalState?.content ?? ""; // Provide content for token counting
    const formattedStatResult = finalState?.stat
      ? await createFormattedStatWithTokenCount(
          finalState.stat,
          finalContentForStat,
          context,
        ) // Await the async utility
      : undefined;
    // Ensure stat is undefined if the utility returned null (e.g., token counting failed)
    const formattedStat =
      formattedStatResult === null ? undefined : formattedStatResult;

    // Construct the final response object.
    const response: ObsidianUpdateFileResponse = {
      success: true,
      message: successMessage,
      stats: formattedStat,
      verification,
    };

    // Include final content if requested and available.
    if (params.returnContent) {
      response.finalContent = finalState?.content; // Assign content if available, otherwise undefined
      logger.debug(
        `Including final content in response as requested.`,
        context,
      );
    }

    return response;
  } catch (error) {
    // Preserve T2 structured error types so the wrapper can render them as
    // hash_mismatch / lock_timeout / retry_exhausted instead of internal_error.
    if (
      error instanceof HashMismatchError ||
      error instanceof WriteLockTimeoutError ||
      error instanceof WriteRetryExhaustedError
    ) {
      throw error;
    }
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
