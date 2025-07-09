/**
 * @fileoverview Registration for the Obsidian Create Task tool.
 * Registers the `obsidian_create_task` tool with the MCP server.
 * @module obsidianCreateTaskTool/registration
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
  CreateTaskInputSchema,
  obsidianCreateTaskLogic,
  type CreateTaskInput,
  type CreateTaskResponse,
} from "./logic.js";

/**
 * Registers the 'obsidian_create_task' tool with the MCP server.
 * 
 * This tool enables creating tasks in Obsidian with full Tasks plugin metadata support,
 * including priorities, dates, tags, and intelligent file targeting.
 * 
 * @param server - The MCP server instance to register the tool with
 * @param obsidianService - The Obsidian REST API service instance
 * @returns Promise that resolves when registration is complete
 * @throws McpError if registration fails critically
 */
export const registerObsidianCreateTaskTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> => {
  const toolName = "obsidian_create_task";
  const toolDescription = `Create tasks in Obsidian with full Tasks plugin metadata support and intelligent targeting.

This tool creates properly formatted tasks with comprehensive metadata support, automatic file targeting, and flexible positioning options.

**Features:**
- Full Obsidian Tasks plugin format support
- Intelligent file targeting (active file, periodic notes, or explicit path)
- Complete metadata support (priorities, dates, tags, projects, recurrence)
- Flexible positioning and section targeting
- Task hierarchy support with indentation
- Natural language date parsing

**Target Options:**
- \`useActiveFile=true\` - Create task in currently active file
- \`usePeriodicNote="daily"\` - Create in today's daily note
- \`usePeriodicNote="weekly"\` - Create in this week's note
- \`usePeriodicNote="monthly"\` - Create in this month's note
- \`filePath="path/to/file.md"\` - Create in specific file

**Metadata Support:**
- \`status\`: incomplete, completed, in-progress, cancelled, deferred, scheduled
- \`priority\`: highest (🔺), high (🔴), medium (🟡), low (🟢), lowest (🔻)
- \`dueDate\`: "2024-06-19", "tomorrow", "next Friday"
- \`scheduledDate\`: When to work on the task
- \`startDate\`: When task becomes available
- \`tags\`: ["urgent", "work", "project"]
- \`project\`: Project name (creates #project/name tag)
- \`recurrence\`: "every day", "every week", "every month"

**Positioning Options:**
- \`insertAt\`: "top", "bottom", "after-heading"
- \`section\`: "Tasks", "TODO", "Project Alpha" (heading name)
- \`indentLevel\`: 0-6 for task hierarchy
- \`listStyle\`: "-", "*", "1." for different list markers

**Examples:**
- Basic task: text="Review documents"
- With metadata: text="Call client", priority="high", dueDate="tomorrow", tags=["urgent"]
- In daily note: text="Morning routine", usePeriodicNote="daily", section="Tasks"
- With hierarchy: text="Subtask", indentLevel=1, insertAt="after-heading", section="Project"
- Recurring task: text="Weekly review", recurrence="every Friday", priority="medium"`;

  // Create context for registration process
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianCreateTaskTool",
      toolName: toolName,
      module: "ObsidianCreateTaskRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration
      server.tool(
        toolName,
        toolDescription,
        CreateTaskInputSchema.shape, // Provide the Zod schema shape for input definition
        /**
         * The handler function executed when the 'obsidian_create_task' tool is called.
         *
         * @param params - The input parameters received from the client, validated against the schema
         * @returns Promise resolving to the structured result for the MCP client
         */
        async (params: CreateTaskInput) => {
          // Create a specific context for this handler invocation
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianCreateTaskRequest",
              toolName: toolName,
              params: {
                text: params.text.substring(0, 50),
                status: params.status,
                priority: params.priority,
                useActiveFile: params.useActiveFile,
                usePeriodicNote: params.usePeriodicNote,
                filePath: params.filePath,
                hasMetadata: !!(params.dueDate || params.scheduledDate || params.startDate || params.tags?.length),
              },
            });

          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block
          return await ErrorHandler.tryCatch(
            async () => {
              // Execute the task creation logic
              const response: CreateTaskResponse =
                await obsidianCreateTaskLogic(
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
              input: { ...params, text: params.text.substring(0, 50) },
            },
          );
        },
      );

      logger.info(`Successfully registered tool: ${toolName}`, registrationContext);
    },
    {
      operation: "registerObsidianCreateTaskTool",
      context: registrationContext,
    },
  );
};