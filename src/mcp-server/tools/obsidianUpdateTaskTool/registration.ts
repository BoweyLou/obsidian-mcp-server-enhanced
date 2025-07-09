/**
 * @fileoverview Registration for the Obsidian Update Task tool.
 * Registers the `obsidian_update_task` tool with the MCP server.
 * @module obsidianUpdateTaskTool/registration
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
  UpdateTaskInputSchema,
  obsidianUpdateTaskLogic,
  type UpdateTaskInput,
  type UpdateTaskResponse,
} from "./logic.js";

/**
 * Registers the 'obsidian_update_task' tool with the MCP server.
 * 
 * This tool enables modifying existing tasks in Obsidian with comprehensive operation support
 * including status changes, metadata updates, and task movement.
 * 
 * @param server - The MCP server instance to register the tool with
 * @param obsidianService - The Obsidian REST API service instance
 * @returns Promise that resolves when registration is complete
 * @throws McpError if registration fails critically
 */
export const registerObsidianUpdateTaskTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> => {
  const toolName = "obsidian_update_task";
  const toolDescription = `Update and modify existing tasks in Obsidian with comprehensive operation support.

This tool provides extensive task modification capabilities with precise task identification and comprehensive metadata updates.

**Features:**
- Multiple task identification methods (line number or text search)
- Comprehensive status management with all Obsidian Tasks plugin states
- Complete metadata updates (priorities, dates, tags, projects, recurrence)
- Intelligent task completion with automatic date stamps
- Change tracking and detailed operation reporting

**Task Identification:**
- \`lineNumber=42\` - Update task at specific line number
- \`taskText="Review documents"\` - Find task by text content
- \`exactMatch=false\` - Use partial text matching for search

**Operations:**
1. **Status Operations:**
   - \`toggle-status\` - Toggle between incomplete/completed
   - \`set-status\` - Set specific status (incomplete, completed, in-progress, cancelled, deferred, scheduled)
   - \`complete-task\` - Mark complete with automatic completion date

2. **Content Operations:**
   - \`update-text\` - Change task description
   - \`set-priority\` - Set priority (highest, high, medium, low, lowest)

3. **Date Operations:**
   - \`set-due-date\` - Set or update due date
   - \`set-scheduled-date\` - Set when to work on task
   - \`set-start-date\` - Set when task becomes available

4. **Organization Operations:**
   - \`add-tags\` - Add tags to task
   - \`remove-tags\` - Remove specific tags
   - \`set-project\` - Assign to project
   - \`set-recurrence\` - Set recurring pattern

5. **Movement Operations:**
   - \`move-task\` - Move task to different line or section

**Priority Levels:**
- \`highest\` - 🔺 Highest priority
- \`high\` - 🔴 High priority  
- \`medium\` - 🟡 Medium priority
- \`low\` - 🟢 Low priority
- \`lowest\` - 🔻 Lowest priority

**Date Format Support:**
- Natural language: "tomorrow", "next Friday", "in 2 days"
- ISO format: "2024-06-19"
- Relative: "today", "next week"

**Examples:**
- Toggle completion: operation="toggle-status", lineNumber=15
- Set high priority: operation="set-priority", taskText="Review PR", priority="high"
- Set due date: operation="set-due-date", lineNumber=8, dueDate="tomorrow"
- Add tags: operation="add-tags", taskText="Meeting prep", tags=["urgent", "meeting"]
- Complete task: operation="complete-task", lineNumber=25
- Update text: operation="update-text", lineNumber=10, newText="Updated task description"`;

  // Create context for registration process
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianUpdateTaskTool",
      toolName: toolName,
      module: "ObsidianUpdateTaskRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration
      server.tool(
        toolName,
        toolDescription,
        UpdateTaskInputSchema.shape, // Provide the Zod schema shape for input definition
        /**
         * The handler function executed when the 'obsidian_update_task' tool is called.
         *
         * @param params - The input parameters received from the client, validated against the schema
         * @returns Promise resolving to the structured result for the MCP client
         */
        async (params: UpdateTaskInput) => {
          // Create a specific context for this handler invocation
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianUpdateTaskRequest",
              toolName: toolName,
              params: {
                filePath: params.filePath,
                operation: params.operation,
                lineNumber: params.lineNumber,
                taskText: params.taskText?.substring(0, 50),
                hasUpdates: !!(params.newText || params.priority || params.dueDate || params.tags?.length),
              },
            });

          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block
          return await ErrorHandler.tryCatch(
            async () => {
              // Execute the task update logic
              const response: UpdateTaskResponse =
                await obsidianUpdateTaskLogic(
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
              input: { ...params, taskText: params.taskText?.substring(0, 50) },
            },
          );
        },
      );

      logger.info(`Successfully registered tool: ${toolName}`, registrationContext);
    },
    {
      operation: "registerObsidianUpdateTaskTool",
      context: registrationContext,
    },
  );
};