/**
 * @fileoverview Registration for the Obsidian Tasks Query Builder tool.
 * Registers the `obsidian_tasks_query_builder` tool with the MCP server.
 * @module obsidianTasksQueryBuilderTool/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultManager } from "../../../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  TasksQueryBuilderInputSchema,
  obsidianTasksQueryBuilderLogic,
  type TasksQueryBuilderInput,
  type TasksQueryBuilderResponse,
} from "./logic.js";

/**
 * Registers the 'obsidian_tasks_query_builder' tool with the MCP server.
 * 
 * This tool enables building and executing native Tasks plugin queries using either
 * raw query syntax or structured parameters.
 * 
 * @param server - The MCP server instance to register the tool with
 * @param vaultManager - The VaultManager instance for multi-vault support
 * @returns Promise that resolves when registration is complete
 * @throws McpError if registration fails critically
 */
export const registerObsidianTasksQueryBuilderTool = async (
  server: McpServer,
  vaultManager: VaultManager,
): Promise<void> => {
  const toolName = "obsidian_tasks_query_builder";
  const toolDescription = `Build and execute native Obsidian Tasks plugin queries with structured parameters or raw syntax.

This tool provides a powerful interface for creating complex task queries using the official Tasks plugin syntax, with both structured parameter building and raw query support.

**Core Features:**
- **Native Tasks Plugin Syntax**: Generate queries using official Tasks plugin format
- **Structured Query Building**: Build queries using parameters instead of raw syntax
- **Query Validation**: Validate and explain generated queries
- **Multi-Vault Support**: Execute queries across different vaults
- **Comprehensive Filtering**: Status, priority, dates, tags, paths, and more

**Query Building Methods:**

1. **Raw Query Syntax** (Advanced):
   - Provide direct Tasks plugin query in \`query\` parameter
   - Full control over Tasks plugin features
   - Example: \`query: "not done\\ndue before tomorrow\\ngroup by folder\\nsort by priority reverse"\`

2. **Structured Parameters** (Recommended):
   - Use \`filters\` object for conditions
   - Use \`groupBy\` array for grouping
   - Use \`sortBy\` array for sorting
   - Use \`hideOptions\` for display customization

**Supported Filters:**
- **Status**: todo, done, in-progress, cancelled, deferred, scheduled
- **Priority**: highest, high, medium, low, lowest  
- **Dates**: due, scheduled, starts, created, done (with relative dates like 'today', 'before tomorrow')
- **Tags**: Filter by task tags
- **Path**: Filter by file path
- **Special**: recurring tasks, tasks with descriptions

**Grouping Options:**
- status, priority, due, scheduled, starts, created, done
- filename, folder, path, tag, heading, urgency, recurring

**Sorting Options:**
- Any grouping field with optional reverse direction

**Display Customization:**
- Hide various UI elements: edit button, postpone button, backlinks
- Hide metadata: priority, dates, recurrence rules, task count

**Multi-Vault Support:**
- Default vault: omit \`vault\` parameter
- Specific vault: \`vault: "work"\` or \`vault: "personal"\`

**Examples:**

1. **Simple filter example**:
   \`\`\`json
   {
     "filters": {
       "status": ["todo"],
       "priority": ["high", "highest"],
       "due": "before tomorrow"
     },
     "sortBy": [{"field": "due", "reverse": false}]
   }
   \`\`\`

2. **Complex query with grouping**:
   \`\`\`json
   {
     "filters": {
       "status": ["todo", "in-progress"],
       "tags": ["work", "urgent"]
     },
     "groupBy": ["priority", "folder"],
     "sortBy": [{"field": "urgency", "reverse": true}],
     "limit": 50
   }
   \`\`\`

3. **Raw query for advanced users**:
   \`\`\`json
   {
     "query": "not done\\ndue before tomorrow\\ntags include #urgent\\ngroup by folder\\nsort by priority reverse\\nlimit 25"
   }
   \`\`\`

**Output:**
- Generated Tasks plugin query syntax
- Query results (when possible)
- Query explanation (when \`explain: true\`)
- Execution details and performance metrics

**Note:** The generated queries can be copied and used directly in Obsidian Tasks plugin code blocks for full functionality.`;

  // Create context for registration process
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianTasksQueryBuilderTool",
      toolName: toolName,
      module: "ObsidianTasksQueryBuilderRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration
      server.tool(
        toolName,
        toolDescription,
        TasksQueryBuilderInputSchema.shape, // Provide the Zod schema shape for input definition
        /**
         * The handler function executed when the 'obsidian_tasks_query_builder' tool is called.
         *
         * @param params - The input parameters received from the client, validated against the schema
         * @returns Promise resolving to the structured result for the MCP client
         */
        async (params: TasksQueryBuilderInput) => {
          // Create a specific context for this handler invocation
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianTasksQueryBuilderRequest",
              toolName: toolName,
              params: {
                hasRawQuery: !!params.query,
                hasFilters: !!params.filters,
                vault: params.vault,
                explain: params.explain,
                limit: params.limit,
              },
            });

          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block
          return await ErrorHandler.tryCatch(
            async () => {
              // Get the appropriate Obsidian service based on vault parameter
              const obsidianService = vaultManager.getVaultService(params.vault, handlerContext);
              
              // Execute the Tasks query builder logic
              const response: TasksQueryBuilderResponse =
                await obsidianTasksQueryBuilderLogic(
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
      operation: "registerObsidianTasksQueryBuilderTool",
      context: registrationContext,
    },
  );
};