import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultManager } from "../../../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  buildWriteLockKey,
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
  runWriteTool,
} from "../../../utils/index.js";
// Import necessary types and schemas from the logic file
import type { ObsidianSearchReplaceRegistrationInput } from "./logic.js";
import {
  ObsidianSearchReplaceInputSchema,
  ObsidianSearchReplaceInputSchemaShape,
  processObsidianSearchReplace,
} from "./logic.js";

/**
 * Registers the 'obsidian_search_replace' tool with the MCP server.
 *
 * This tool performs one or more search-and-replace operations within a specified
 * Obsidian note (identified by file path, the active file, or a periodic note).
 * It reads the note content, applies the replacements sequentially based on the
 * provided options (regex, case sensitivity, etc.), writes the modified content
 * back to the vault, and returns the operation results.
 *
 * The response includes success status, a summary message, the total number of
 * replacements made, formatted file statistics (timestamp, token count), and
 * optionally the final content of the note.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service
 *   used to interact with the user's Obsidian vault.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianSearchReplaceTool = async (
  server: McpServer,
  vaultManager: VaultManager,
): Promise<void> => {
  const toolName = "obsidian_search_replace";
  const toolDescription =
    "Performs one or more search-and-replace operations within a target Obsidian note (file path, active, or periodic). Reads the file, applies replacements sequentially in memory, and writes the modified content back, overwriting the original. Supports string/regex search, case sensitivity toggle, replacing first/all occurrences, flexible whitespace matching (non-regex), and whole word matching. Returns success status, message, replacement count, a formatted timestamp string, file stats (stats), and optionally the final file content.";

  // Create a context specifically for the registration process.
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianSearchReplaceTool",
      toolName: toolName,
      module: "ObsidianSearchReplaceRegistration", // Identify the module
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling during server setup.
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration.
      // It handles schema generation from the shape, basic validation, and routing.
      server.tool(
        toolName,
        toolDescription,
        ObsidianSearchReplaceInputSchemaShape, // Provide the base Zod schema shape for input definition.
        /**
         * The handler function executed when the 'obsidian_search_replace' tool is called by the client.
         *
         * @param {ObsidianSearchReplaceRegistrationInput} params - The raw input parameters received from the client,
         *   matching the structure defined by ObsidianSearchReplaceInputSchemaShape.
         * @returns {Promise<CallToolResult>} A promise resolving to the structured result for the MCP client,
         *   containing either the successful response data (serialized JSON) or an error indication.
         */
        async (params: ObsidianSearchReplaceRegistrationInput) => {
          // Create a specific context for this handler invocation, linked to the registration context.
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianSearchReplaceRequest",
              toolName: toolName,
              params: {
                // Log key parameters for debugging (excluding potentially large replacements array)
                targetType: params.targetType,
                targetIdentifier: params.targetIdentifier,
                replacementCount: params.replacements?.length ?? 0, // Log count instead of full array
                useRegex: params.useRegex,
                replaceAll: params.replaceAll,
                caseSensitive: params.caseSensitive,
                flexibleWhitespace: params.flexibleWhitespace,
                wholeWord: params.wholeWord,
                returnContent: params.returnContent,
              },
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // T1.2/T1.3/T1.4/T1.5 — runWriteTool wraps validation, retry,
          // verification, idempotency caching, and structured error mapping.
          return await runWriteTool({
            toolName,
            idempotencyKey: params.idempotency_key,
            lockKey: buildWriteLockKey(
              params.vault,
              params.targetType === "filePath"
                ? params.targetIdentifier
                : params.targetType === "activeFile"
                  ? "__active__"
                  : `__periodic_${params.targetIdentifier ?? "unknown"}__`,
            ),
            context: handlerContext,
            errorContext: {
              file: params.targetIdentifier,
              targetType: params.targetType,
            },
            handler: async () => {
              const validatedParams =
                ObsidianSearchReplaceInputSchema.parse(params);
              return await processObsidianSearchReplace(
                validatedParams,
                handlerContext,
                vaultManager,
              );
            },
          });
        },
      ); // End of server.tool call

      logger.info(
        `Tool registered successfully: ${toolName}`,
        registrationContext,
      );
    },
    {
      // Configuration for the outer error handler (registration process).
      operation: `registering tool ${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR, // Default error code for registration failure.
      // Custom error mapping for registration failures.
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext }, // Include context
        ),
      critical: true, // Treat registration failure as critical, potentially halting server startup.
    },
  ); // End of outer ErrorHandler.tryCatch
};
