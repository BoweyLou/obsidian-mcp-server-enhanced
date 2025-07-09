/**
 * @fileoverview Registration for the Obsidian Task Query tool.
 * Registers the `obsidian_task_query` tool with the MCP server.
 * @module obsidianTaskQueryTool/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  TaskQueryInputSchema,
  obsidianTaskQueryLogic,
  type TaskQueryInput,
  type TaskQueryResponse,
} from "./logic.js";

/**
 * Registers the 'obsidian_task_query' tool with the MCP server.
 * 
 * This tool enables searching and analyzing tasks across the Obsidian vault,
 * providing powerful filtering, sorting, and formatting capabilities for task management.
 * 
 * @param server - The MCP server instance to register the tool with
 * @param obsidianService - The Obsidian REST API service instance
 * @returns Promise that resolves when registration is complete
 * @throws McpError if registration fails critically
 */
export const registerObsidianTaskQueryTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> => {
  const toolName = "obsidian_task_query";
  const toolDescription = `Enhanced search and analysis of tasks across your Obsidian vault with full Obsidian Tasks plugin support.

This tool provides comprehensive task management with complete Obsidian Tasks plugin compatibility, advanced filtering, and intelligent sorting.

**Enhanced Features:**
- Full Obsidian Tasks plugin format support
- Intelligent Dataview integration for efficient discovery
- Advanced task hierarchy and subtask parsing
- Urgency scoring based on priority + due date proximity
- Enhanced date range filtering with smart date selection

**Task Status Support:**
- \`- [ ]\` Incomplete tasks
- \`- [x]\` Completed tasks  
- \`- [/]\` In-progress tasks
- \`- [-]\` Cancelled tasks
- \`- [>]\` Deferred tasks
- \`- [<]\` Scheduled tasks

**Priority Support (Obsidian Tasks Plugin):**
- 🔺 or ⏫ for highest priority
- 🔴, ‼️, ❗, 🚨, ⬆️ for high priority
- 🟡, 🟠, ➡️ for medium priority  
- 🔵, 🟢, ⬇️, 🔽 for low priority
- 🔻 or ⏬ for lowest priority

**Date Format Support:**
- \`📅 2024-06-19\` Due dates
- \`⏳ 2024-06-19\` Scheduled dates
- \`🛫 2024-06-19\` Start dates
- \`✅ 2024-06-19\` Completion dates
- \`➕ 2024-06-19\` Created dates
- \`🔁 every week\` Recurring tasks

**Enhanced Date Ranges:**
- today, yesterday, tomorrow
- this-week, next-week, last-week
- this-month, next-month, last-month
- overdue, upcoming, all-time

**Examples:**
- Find all incomplete tasks: status="incomplete"
- Today's tasks: dateRange="today"
- Overdue tasks: dateRange="overdue"
- High priority tasks: priority="high" or priority="highest"
- Tasks in specific folder: folder="Projects/Active"
- Tasks with specific tags: tags=["urgent", "work"]
- Summary view: format="summary"
- Detailed analysis: format="table"`;

  // Create context for registration process
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianTaskQueryTool",
      toolName: toolName,
      module: "ObsidianTaskQueryRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration
      server.tool(
        toolName,
        toolDescription,
        TaskQueryInputSchema.shape, // Provide the Zod schema shape for input definition
        /**
         * The handler function executed when the 'obsidian_task_query' tool is called.
         *
         * @param params - The input parameters received from the client, validated against the schema
         * @returns Promise resolving to the structured result for the MCP client
         */
        async (params: TaskQueryInput) => {
          // Create a specific context for this handler invocation
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianTaskQueryRequest",
              toolName: toolName,
              params: {
                status: params.status,
                dateRange: params.dateRange,
                format: params.format,
                folder: params.folder,
                tagsCount: params.tags?.length || 0,
                priority: params.priority,
                limit: params.limit,
              },
            });

          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block
          return await ErrorHandler.tryCatch(
            async () => {
              // Execute the task query logic
              const response: TaskQueryResponse =
                await obsidianTaskQueryLogic(
                  params,
                  handlerContext,
                  obsidianService,
                );

              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
              );

              // Format the successful response object into the required MCP CallToolResult structure
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
            },
          );
        },
      );

      logger.info(`Successfully registered tool: ${toolName}`, registrationContext);
    },
    {
      operation: "registerObsidianTaskQueryTool",
      context: registrationContext,
    },
  );
};