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
import type { ObsidianManageTagsInput } from "./logic.js";
import {
  ManageTagsInputSchema,
  ObsidianManageTagsInputSchemaShape,
  processObsidianManageTags,
} from "./logic.js";

export const registerObsidianManageTagsTool = async (
  server: McpServer,
  vaultManager: VaultManager,
): Promise<void> => {
  const toolName = "obsidian_manage_tags";
  const toolDescription =
    "Manages tags for a specified note, handling them in both the YAML frontmatter and inline content. Supports adding, removing, and listing tags to provide a comprehensive tag management solution.";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianManageTagsTool",
      toolName: toolName,
      module: "ObsidianManageTagsRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianManageTagsInputSchemaShape,
        async (params: ObsidianManageTagsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianManageTagsRequest",
              toolName: toolName,
              params: params,
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // T1.2/T1.3/T1.4/T1.5 — runWriteTool wraps validation, retry,
          // verification, idempotency caching, and structured error mapping.
          return await runWriteTool({
            toolName,
            idempotencyKey: params.idempotency_key,
            lockKey: buildWriteLockKey(params.vault, params.filePath),
            context: handlerContext,
            errorContext: {
              file: params.filePath,
              op: params.operation,
              tagCount: params.tags?.length ?? 0,
            },
            handler: async () => {
              const validatedParams = ManageTagsInputSchema.parse(params);
              return await processObsidianManageTags(
                validatedParams,
                handlerContext,
                vaultManager,
              );
            },
          });
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
