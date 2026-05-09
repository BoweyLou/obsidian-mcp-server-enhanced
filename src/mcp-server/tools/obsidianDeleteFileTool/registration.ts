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
// Import necessary types, schema, and logic function from the logic file
import type { ObsidianDeleteFileInput } from "./logic.js";
import {
  ObsidianDeleteFileInputSchema,
  processObsidianDeleteFile,
} from "./logic.js";

/**
 * Registers the 'obsidian_delete_file' tool with the MCP server.
 *
 * This tool permanently deletes a specified file from the user's Obsidian vault.
 * It requires the vault-relative path, including the file extension. The tool
 * attempts a case-sensitive deletion first, followed by a case-insensitive
 * fallback search and delete if the initial attempt fails with a 'NOT_FOUND' error.
 *
 * The response is a JSON string containing a success status and a confirmation message.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service
 *   used to interact with the user's Obsidian vault.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianDeleteFileTool = async (
  server: McpServer,
  vaultManager: VaultManager,
): Promise<void> => {
  const toolName = "obsidian_delete_file";
  // Updated description to accurately reflect the response (no timestamp)
  const toolDescription =
    "Permanently deletes a specified file from the Obsidian vault. Supports multi-vault setups - specify 'vault' parameter to target a specific vault, or omit for default vault. Tries the exact path first, then attempts a case-insensitive fallback if the file is not found. Requires the vault-relative path including the file extension. Returns a success message.";

  // Create a context specifically for the registration process.
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianDeleteFileTool",
      toolName: toolName,
      module: "ObsidianDeleteFileRegistration", // Identify the module
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling during server setup.
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration.
      server.tool(
        toolName,
        toolDescription,
        ObsidianDeleteFileInputSchema.shape, // Provide the Zod schema shape for input definition.
        /**
         * The handler function executed when the 'obsidian_delete_file' tool is called by the client.
         *
         * @param {ObsidianDeleteFileInput} params - The input parameters received from the client,
         *   validated against the ObsidianDeleteFileInputSchema shape.
         * @returns {Promise<CallToolResult>} A promise resolving to the structured result for the MCP client,
         *   containing either the successful response data (serialized JSON) or an error indication.
         */
        async (params: ObsidianDeleteFileInput) => {
          // Type matches the inferred input schema
          // Create a specific context for this handler invocation.
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext, // Link to registration context
              operation: "HandleObsidianDeleteFileRequest",
              toolName: toolName,
              params: { filePath: params.filePath }, // Log the file path being targeted
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // T1.2/T1.3/T1.4/T1.5 — runWriteTool wraps validation, retry,
          // verification, idempotency caching, and structured error mapping.
          return await runWriteTool({
            toolName,
            idempotencyKey: params.idempotency_key,
            lockKey: buildWriteLockKey(params.vault, params.filePath),
            context: handlerContext,
            errorContext: { file: params.filePath },
            handler: async () => {
              return await processObsidianDeleteFile(
                params,
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
      critical: true, // Treat registration failure as critical.
    },
  ); // End of outer ErrorHandler.tryCatch
};
