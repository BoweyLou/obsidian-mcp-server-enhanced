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
import type { ObsidianManageFrontmatterInput } from "./logic.js";
import {
  ManageFrontmatterInputSchema,
  ObsidianManageFrontmatterInputSchemaShape,
  processObsidianManageFrontmatter,
} from "./logic.js";

export const registerObsidianManageFrontmatterTool = async (
  server: McpServer,
  vaultManager: VaultManager,
): Promise<void> => {
  const toolName = "obsidian_manage_frontmatter";
  const toolDescription =
    "Atomically manages a note's YAML frontmatter. Supports getting, setting (creating/updating), and deleting specific keys without rewriting the entire file. Ideal for efficient metadata operations on primitive or structured Obsidian frontmatter data.";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianManageFrontmatterTool",
      toolName: toolName,
      module: "ObsidianManageFrontmatterRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianManageFrontmatterInputSchemaShape,
        async (params: ObsidianManageFrontmatterInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianManageFrontmatterRequest",
              toolName: toolName,
              params: params,
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // T1.2/T1.3/T1.4/T1.5 — runWriteTool wraps validation, retry,
          // verification, idempotency caching, and structured error mapping.
          // The 'get' op is read-only; we still run it through the wrapper
          // for uniform error shape, but it skips the idempotency cache
          // unless the caller chose to pass a key.
          return await runWriteTool({
            toolName,
            idempotencyKey: params.idempotency_key,
            // 'get' is read-only and doesn't need serialization, but locking
            // a read against a concurrent write is harmless and keeps the
            // wiring uniform across operations.
            lockKey:
              params.operation === "get"
                ? undefined
                : buildWriteLockKey(params.vault, params.filePath),
            context: handlerContext,
            errorContext: {
              file: params.filePath,
              op: params.operation,
              key: params.key,
            },
            handler: async () => {
              const validatedParams =
                ManageFrontmatterInputSchema.parse(params);
              return await processObsidianManageFrontmatter(
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
