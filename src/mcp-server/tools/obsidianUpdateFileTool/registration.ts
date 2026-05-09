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
// Import types for handler signature
import type { ObsidianUpdateFileRegistrationInput } from "./logic.js";
// Import the Zod schema for validation and the core processing logic
import {
  ObsidianUpdateFileInputSchema,
  ObsidianUpdateFileInputSchemaShape,
  processObsidianUpdateFile,
} from "./logic.js";

/**
 * Registers the 'obsidian_update_file' tool with the MCP server.
 *
 * This tool allows modification of Obsidian notes (specified by file path,
 * the active file, or a periodic note) using whole-file operations:
 * 'append', 'prepend', or 'overwrite'. It includes options for creating
 * missing files/targets and controlling overwrite behavior.
 *
 * The tool returns a JSON string containing the operation status, a message,
 * a formatted timestamp of the operation, file statistics (stat), and
 * optionally the final content of the modified file.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service
 *   used to interact with the user's Obsidian vault.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianUpdateFileTool = async (
  server: McpServer,
  vaultManager: VaultManager,
): Promise<void> => {
  const toolName = "obsidian_update_file";
  const toolDescription =
    "Tool to modify Obsidian notes (specified by file path, the active file, or a periodic note) using whole-file operations: 'append', 'prepend', or 'overwrite'. Options allow creating missing files/targets and controlling overwrite behavior. Returns success status, message, a formatted timestamp string, file stats (stats), and optionally the final file content.";

  // Create a context for the registration process itself for better traceability.
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianUpdateFileTool",
      toolName: toolName,
      module: "ObsidianUpdateFileRegistration", // Identify the module performing registration
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration in a tryCatch block for robust error handling during setup.
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method for tool registration.
      // This handles schema generation, validation, and routing automatically.
      server.tool(
        toolName,
        toolDescription,
        ObsidianUpdateFileInputSchemaShape, // Provide the Zod schema shape for input validation.
        /**
         * The handler function executed when the 'obsidian_update_file' tool is called.
         *
         * @param {ObsidianUpdateFileRegistrationInput} params - The raw input parameters received from the client,
         *   matching the structure defined by ObsidianUpdateFileInputSchemaShape.
         * @returns {Promise<CallToolResult>} A promise resolving to the structured result for the MCP client,
         *   containing either the successful response data or an error indication.
         */
        async (params: ObsidianUpdateFileRegistrationInput) => {
          // Create a specific context for this handler invocation.
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext, // Link to the registration context
              operation: "HandleObsidianUpdateFileRequest",
              toolName: toolName,
              params: {
                // Log key parameters for easier debugging, content is omitted for brevity/security
                targetType: params.targetType,
                modificationType: params.modificationType, // Note: Will always be 'wholeFile' due to schema
                targetIdentifier: params.targetIdentifier,
                wholeFileMode: params.wholeFileMode,
                createIfNeeded: params.createIfNeeded,
                overwriteIfExists: params.overwriteIfExists,
                returnContent: params.returnContent,
              },
            });
          logger.debug(
            `Handling '${toolName}' request (wholeFile mode)`,
            handlerContext,
          );

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
              wholeFileMode: params.wholeFileMode,
            },
            handler: async () => {
              const validatedParams =
                ObsidianUpdateFileInputSchema.parse(params);
              const response = await processObsidianUpdateFile(
                validatedParams,
                handlerContext,
                vaultManager,
              );
              logger.debug(
                `'${toolName}' (wholeFile mode) processed successfully`,
                handlerContext,
              );
              return response;
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
      errorCode: BaseErrorCode.INTERNAL_ERROR, // Default error code for registration failure
      // Custom error mapping for registration failures.
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext }, // Include context
        ),
      critical: true, // Registration failure is considered critical and should likely halt server startup.
    },
  ); // End of outer ErrorHandler.tryCatch
};
