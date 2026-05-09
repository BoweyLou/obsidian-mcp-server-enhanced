import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultManager } from "../../../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import type {
  ObsidianBatchReadFilesInput,
  ObsidianBatchReadFilesResponse,
} from "./logic.js";
import {
  ObsidianBatchReadFilesInputSchema,
  processObsidianBatchReadFiles,
} from "./logic.js";

/**
 * Registers the 'obsidian_batch_read_files' tool with the MCP server.
 *
 * This tool reads multiple files from the Obsidian vault in a single operation,
 * returning all their contents concatenated with headers showing each file path.
 * It supports the same case-insensitive fallback mechanism as the single file read tool.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {VaultManager} vaultManager - The VaultManager instance for multi-vault support.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianBatchReadFilesTool = async (
  server: McpServer,
  vaultManager: VaultManager,
): Promise<void> => {
  const toolName = "obsidian_batch_read_files";
  const toolDescription =
    "Reads multiple files from the Obsidian vault in a single operation. Supports multi-vault setups - specify 'vault' parameter to target a specific vault, or omit for default vault. Accepts an array of vault-relative file paths and returns all their contents concatenated with headers showing each file path. Uses case-sensitive matching first with case-insensitive fallback for each file. Files that cannot be read are reported with errors but do not prevent other files from being read.";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianBatchReadFilesTool",
      toolName: toolName,
      module: "ObsidianBatchReadFilesRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianBatchReadFilesInputSchema.shape,
        async (params: ObsidianBatchReadFilesInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianBatchReadFilesRequest",
              toolName: toolName,
              params: {
                fileCount: params.filePaths.length,
                vault: params.vault,
              },
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          return await ErrorHandler.tryCatch(
            async () => {
              const response: ObsidianBatchReadFilesResponse =
                await processObsidianBatchReadFiles(
                  params,
                  handlerContext,
                  vaultManager,
                );
              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
              );

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(response, null, 2),
                  },
                ],
                isError: false,
              };
            },
            {
              operation: `processing ${toolName} handler`,
              context: handlerContext,
              input: params,
              errorMapper: (error: unknown) =>
                new McpError(
                  error instanceof McpError
                    ? error.code
                    : BaseErrorCode.INTERNAL_ERROR,
                  `Error processing ${toolName} tool: ${error instanceof Error ? error.message : "Unknown error"}`,
                  { ...handlerContext },
                ),
            },
          );
        },
      );

      logger.info(
        `Tool registered successfully: ${toolName}`,
        registrationContext,
      );
    },
    {
      operation: `registering tool ${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext },
        ),
      critical: true,
    },
  );
};
