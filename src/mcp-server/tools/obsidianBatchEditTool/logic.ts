import { z } from "zod";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { VaultManager } from "../../../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, RequestContext } from "../../../utils/index.js";

// ====================================================================================
// Schema Definitions for Input Validation
// ====================================================================================

/** Defines the supported per-edit operations. */
const BatchEditOperationSchema = z
  .enum(["searchReplace", "append", "prepend", "overwrite"])
  .describe(
    "The operation to perform on the file: 'searchReplace' (default), 'append', 'prepend', or 'overwrite'.",
  );

/** A single search/replace pair applied to file content. */
const ReplacementBlockSchema = z.object({
  search: z
    .string()
    .min(1, "Search pattern cannot be empty.")
    .describe("The exact string or regex pattern to search for."),
  replace: z.string().describe("The string to replace matches with."),
});

/** A single edit targeting one file within the batch. */
const BatchEditItemSchema = z.object({
  filePath: z
    .string()
    .min(1, "filePath cannot be empty.")
    .describe('The vault-relative path to the target file (e.g., "Folder/Note.md").'),
  operation: BatchEditOperationSchema.optional().default("searchReplace"),
  replacements: z
    .array(ReplacementBlockSchema)
    .optional()
    .describe(
      "Required for 'searchReplace': search/replace pairs applied sequentially to the file content.",
    ),
  content: z
    .string()
    .optional()
    .describe("Required for 'append', 'prepend', and 'overwrite': the content to write."),
});

/**
 * Base Zod schema for the batch edit tool input. Global options (useRegex,
 * caseSensitive, replaceAll) apply to every 'searchReplace' edit in the batch.
 */
const BaseObsidianBatchEditInputSchema = z.object({
  edits: z
    .array(BatchEditItemSchema)
    .min(1, "Edits array cannot be empty.")
    .max(100, "A batch may contain at most 100 edits.")
    .describe(
      "An array of edits (max 100), each targeting one file. Edits are applied sequentially in order, so multiple edits to the same file compound.",
    ),
  vault: z
    .string()
    .optional()
    .describe(
      'The ID of the vault to edit (e.g., "personal", "work"). If not specified, uses the default vault.',
    ),
  useRegex: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, treat every 'search' field as a JavaScript regex pattern. Defaults to false (exact string matching).",
    ),
  caseSensitive: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), searches are case-sensitive. Applies to both string and regex search.",
    ),
  replaceAll: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), replace all occurrences of each search pattern. If false, replace only the first occurrence.",
    ),
  continueOnError: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), a failed edit is recorded and the batch continues. If false, processing stops at the first failure.",
    ),
});

/**
 * Refined schema enforcing per-operation required fields:
 * 'searchReplace' needs a non-empty replacements array; content-based
 * operations ('append', 'prepend', 'overwrite') need a content string.
 */
export const ObsidianBatchEditInputSchema =
  BaseObsidianBatchEditInputSchema.superRefine((data, ctx) => {
    data.edits.forEach((edit, index) => {
      if (edit.operation === "searchReplace") {
        if (!edit.replacements || edit.replacements.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["edits", index, "replacements"],
            message:
              "A non-empty 'replacements' array is required when operation is 'searchReplace'.",
          });
        }
      } else if (edit.content === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edits", index, "content"],
          message: `'content' is required when operation is '${edit.operation}'.`,
        });
      }
    });
  }).describe(
    "Applies a batch of edits across one or more Obsidian notes in a single call. Supports search/replace (string or regex), append, prepend, and overwrite operations. Edits are applied sequentially and results are reported per file, avoiding the per-call round-trip overhead of issuing many individual edit requests.",
  );

/** The shape of the base schema, used by `server.tool` for registration. */
export const ObsidianBatchEditInputSchemaShape =
  BaseObsidianBatchEditInputSchema.shape;

/** Raw input type received by the tool handler before refinement. */
export type ObsidianBatchEditRegistrationInput = z.infer<
  typeof BaseObsidianBatchEditInputSchema
>;

/** Validated input type used within the core processing logic. */
export type ObsidianBatchEditInput = z.infer<
  typeof ObsidianBatchEditInputSchema
>;

// ====================================================================================
// Response Type Definitions
// ====================================================================================

/** Outcome of a single edit within the batch. */
export interface BatchEditResult {
  /** The vault-relative path targeted by this edit. */
  filePath: string;
  /** The operation that was performed (or attempted). */
  operation: z.infer<typeof BatchEditOperationSchema>;
  /** Whether this edit succeeded. */
  success: boolean;
  /** Number of replacements made (searchReplace operations only). */
  replacementsMade?: number;
  /** Error description if the edit failed. */
  error?: string;
  /** True if the edit was never attempted because a prior failure stopped the batch. */
  skipped?: boolean;
}

/** Structure of the response returned by `processObsidianBatchEdit`. */
export interface ObsidianBatchEditResponse {
  /** True only if every edit in the batch succeeded. */
  success: boolean;
  /** Human-readable summary of the batch outcome. */
  message: string;
  /** Total number of edits in the request. */
  totalEdits: number;
  /** Number of edits that succeeded. */
  succeeded: number;
  /** Number of edits that failed. */
  failed: number;
  /** Number of edits skipped after a failure (continueOnError=false only). */
  skipped: number;
  /** Total replacements made across all searchReplace edits. */
  totalReplacementsMade: number;
  /** Per-edit results, in the order the edits were supplied. */
  results: BatchEditResult[];
}

// ====================================================================================
// Helper Functions
// ====================================================================================

/** Escapes characters that have special meaning in regular expressions. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Applies a sequence of search/replace pairs to content in memory.
 * Both string and regex searches are executed via RegExp (string searches are
 * escaped first), which keeps case-insensitivity and first-vs-all semantics uniform.
 *
 * @returns The modified content and the number of replacements made.
 * @throws {McpError} If a user-supplied regex pattern fails to compile.
 */
function applyReplacements(
  content: string,
  replacements: { search: string; replace: string }[],
  options: { useRegex: boolean; caseSensitive: boolean; replaceAll: boolean },
  context: RequestContext,
): { content: string; replacementsMade: number } {
  let modified = content;
  let replacementsMade = 0;

  for (const rep of replacements) {
    const pattern = options.useRegex ? rep.search : escapeRegex(rep.search);
    const flags =
      (options.replaceAll ? "g" : "") + (options.caseSensitive ? "" : "i");

    let replaceRegex: RegExp;
    let countRegex: RegExp;
    try {
      replaceRegex = new RegExp(pattern, flags);
      countRegex = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
    } catch (error) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Invalid regex pattern "${rep.search}": ${error instanceof Error ? error.message : String(error)}`,
        context,
      );
    }

    const matchCount = (modified.match(countRegex) ?? []).length;
    const effectiveCount = options.replaceAll
      ? matchCount
      : Math.min(matchCount, 1);

    if (effectiveCount > 0) {
      modified = modified.replace(replaceRegex, rep.replace);
      replacementsMade += effectiveCount;
    }
  }

  return { content: modified, replacementsMade };
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

/**
 * Processes the core logic for the 'obsidian_batch_edit' tool.
 * Applies each edit sequentially against the target vault. Unlike the
 * single-edit tools, this deliberately skips post-write verification reads,
 * fixed delays, and token counting so large batches complete within client
 * tool-call timeouts. Cache updates for modified files are kicked off in the
 * background after the batch completes.
 *
 * @param {ObsidianBatchEditInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @param {VaultManager} vaultManager - The VaultManager instance for multi-vault support.
 * @returns {Promise<ObsidianBatchEditResponse>} Per-edit results and batch summary.
 */
export const processObsidianBatchEdit = async (
  params: ObsidianBatchEditInput,
  context: RequestContext,
  vaultManager: VaultManager,
): Promise<ObsidianBatchEditResponse> => {
  const { edits, vault: vaultId, useRegex, caseSensitive, replaceAll, continueOnError } =
    params;

  const obsidianService: ObsidianRestApiService = vaultManager.getVaultService(
    vaultId,
    context,
  );
  const vaultCacheService = vaultManager.getVaultCacheService(vaultId, context);

  logger.debug(`Processing obsidian_batch_edit request`, {
    ...context,
    vaultId: vaultId ?? vaultManager.getDefaultVaultId(),
    editCount: edits.length,
    useRegex,
    continueOnError,
  });

  const results: BatchEditResult[] = [];
  const modifiedFiles = new Set<string>();
  let totalReplacementsMade = 0;
  let stopped = false;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const editContext = {
      ...context,
      operation: "processBatchEditItem",
      editIndex: i,
      filePath: edit.filePath,
      editOperation: edit.operation,
    };

    if (stopped) {
      results.push({
        filePath: edit.filePath,
        operation: edit.operation,
        success: false,
        skipped: true,
        error: "Skipped: a previous edit failed and continueOnError is false.",
      });
      continue;
    }

    try {
      if (edit.operation === "searchReplace") {
        const originalContent = (await obsidianService.getFileContent(
          edit.filePath,
          "markdown",
          editContext,
        )) as string;

        const { content: modifiedContent, replacementsMade } =
          applyReplacements(
            originalContent,
            edit.replacements!,
            { useRegex, caseSensitive, replaceAll },
            editContext,
          );

        if (modifiedContent !== originalContent) {
          await obsidianService.updateFileContent(
            edit.filePath,
            modifiedContent,
            editContext,
          );
          modifiedFiles.add(edit.filePath);
        }

        totalReplacementsMade += replacementsMade;
        results.push({
          filePath: edit.filePath,
          operation: edit.operation,
          success: true,
          replacementsMade,
        });
      } else if (edit.operation === "append") {
        // The REST API appends natively and creates the file if missing (single round trip).
        await obsidianService.appendFileContent(
          edit.filePath,
          edit.content!,
          editContext,
        );
        modifiedFiles.add(edit.filePath);
        results.push({
          filePath: edit.filePath,
          operation: edit.operation,
          success: true,
        });
      } else if (edit.operation === "prepend") {
        let existingContent = "";
        try {
          existingContent = (await obsidianService.getFileContent(
            edit.filePath,
            "markdown",
            editContext,
          )) as string;
        } catch (readError) {
          if (
            !(
              readError instanceof McpError &&
              readError.code === BaseErrorCode.NOT_FOUND
            )
          ) {
            throw readError;
          }
          // File doesn't exist yet: prepend degrades to create, matching append's semantics.
        }
        await obsidianService.updateFileContent(
          edit.filePath,
          edit.content! + existingContent,
          editContext,
        );
        modifiedFiles.add(edit.filePath);
        results.push({
          filePath: edit.filePath,
          operation: edit.operation,
          success: true,
        });
      } else {
        // overwrite: updateFileContent overwrites, creating the file if it doesn't exist.
        await obsidianService.updateFileContent(
          edit.filePath,
          edit.content!,
          editContext,
        );
        modifiedFiles.add(edit.filePath);
        results.push({
          filePath: edit.filePath,
          operation: edit.operation,
          success: true,
        });
      }

      logger.debug(
        `Batch edit ${i} (${edit.operation}) succeeded for ${edit.filePath}`,
        editContext,
      );
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Batch edit ${i} (${edit.operation}) failed for ${edit.filePath}: ${errorMsg}`,
        error instanceof Error ? error : undefined,
        editContext,
      );
      results.push({
        filePath: edit.filePath,
        operation: edit.operation,
        success: false,
        error: errorMsg,
      });
      if (!continueOnError) {
        stopped = true;
      }
    }
  }

  // Refresh the cache for modified files in the background. Awaiting these
  // would re-read every file and defeat the purpose of batching; the periodic
  // cache refresh covers any update that fails here.
  if (vaultCacheService && modifiedFiles.size > 0) {
    const cacheContext = { ...context, operation: "batchEditCacheRefresh" };
    for (const filePath of modifiedFiles) {
      vaultCacheService
        .updateCacheForFile(filePath, cacheContext)
        .catch((cacheError: unknown) => {
          logger.warning(
            `Background cache update failed for ${filePath} after batch edit: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`,
            cacheContext,
          );
        });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.length - succeeded - skipped;

  const summaryParts = [
    `Batch edit completed: ${succeeded}/${edits.length} edit(s) succeeded`,
  ];
  if (failed > 0) summaryParts.push(`${failed} failed`);
  if (skipped > 0) summaryParts.push(`${skipped} skipped`);
  if (totalReplacementsMade > 0)
    summaryParts.push(`${totalReplacementsMade} total replacement(s) made`);

  const response: ObsidianBatchEditResponse = {
    success: failed === 0 && skipped === 0,
    message: summaryParts.join(", ") + ".",
    totalEdits: edits.length,
    succeeded,
    failed,
    skipped,
    totalReplacementsMade,
    results,
  };

  logger.info(response.message, { ...context, operation: "batchEditComplete" });
  return response;
};
