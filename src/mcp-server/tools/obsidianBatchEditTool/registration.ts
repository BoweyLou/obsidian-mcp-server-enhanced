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
  ObsidianBatchEditRegistrationInput,
  ObsidianBatchEditResponse,
} from "./logic.js";
import {
  ObsidianBatchEditInputSchema,
  ObsidianBatchEditInputSchemaShape,
  processObsidianBatchEdit,
} from "./logic.js";

/**
 * Registers the 'obsidian_batch_edit' tool with the MCP server.
 *
 * This tool applies many edits across one or more notes in a single call,
 * eliminating the per-call round-trip and verification overhead that causes
 * client timeouts during large edit runs. Each edit targets one file and is
 * either a search/replace (string or regex), append, prepend, or overwrite.
 * Results are reported per edit so partial failures are visible.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {VaultManager} vaultManager - The VaultManager instance for multi-vault support.
 * @returns {Promise<void>} A promise that resolves when registration is complete.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianBatchEditTool = async (
  server: McpServer,
  vaultManager: VaultManager,
): Promise<void> => {
  const toolName = "obsidian_batch_edit";
  const toolDescription =
    "Applies a batch of edits (up to 100) across one or more Obsidian notes in a single call. Each edit targets one file with an operation: 'searchReplace' (default; sequential search/replace pairs, string or regex), 'append', 'prepend', or 'overwrite'. Edits are applied in order, so multiple edits to the same file compound. Global options control regex mode, case sensitivity, and first-vs-all replacement for all searchReplace edits. By default failures are recorded per edit and the batch continues (set continueOnError=false to stop at the first failure). Supports multi-vault setups - specify 'vault' parameter to target a specific vault, or omit for default vault. Strongly preferred over issuing many individual obsidian_search_replace or obsidian_update_file calls: it avoids per-call round trips and post-write verification delays that cause timeouts on large edit runs.";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianBatchEditTool",
      toolName: toolName,
      module: "ObsidianBatchEditRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianBatchEditInputSchemaShape,
        async (params: ObsidianBatchEditRegistrationInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianBatchEditRequest",
              toolName: toolName,
              params: {
                editCount: params.edits?.length,
                vault: params.vault,
                continueOnError: params.continueOnError,
              },
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          return await ErrorHandler.tryCatch(
            async () => {
              // Apply the refined schema for cross-field validation
              // (per-operation required fields) before processing.
              const validatedParams =
                ObsidianBatchEditInputSchema.parse(params);

              const response: ObsidianBatchEditResponse =
                await processObsidianBatchEdit(
                  validatedParams,
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
                    type: "text" as const,
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
