/**
 * @fileoverview Registration for the Obsidian Dataview Query tool.
 * Registers the `obsidian_dataview_query` tool with the MCP server.
 * @module obsidianDataviewQueryTool/registration
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
  DataviewQueryInputSchema,
  obsidianDataviewQueryLogic,
  type DataviewQueryInput,
  type DataviewQueryResponse,
} from "./logic.js";

/**
 * Registers the 'obsidian_dataview_query' tool with the MCP server.
 * 
 * This tool enables executing Dataview DQL queries against the Obsidian vault,
 * allowing powerful data querying and analysis of notes, tasks, and metadata.
 * 
 * @param server - The MCP server instance to register the tool with
 * @param obsidianService - The Obsidian REST API service instance
 * @returns Promise that resolves when registration is complete
 * @throws McpError if registration fails critically
 */
export const registerObsidianDataviewQueryTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> => {
  const toolName = "obsidian_dataview_query";
  const toolDescription = `Execute Dataview DQL (Dataview Query Language) queries against your Obsidian vault.
This tool allows you to run powerful database-style queries to analyze notes, tasks, metadata, and relationships.

Features:
- Execute TABLE, LIST, or TASK queries using Dataview syntax
- Query notes by tags, frontmatter, creation dates, and content
- Aggregate data across your entire vault
- Generate reports and analytics from your notes
- Filter and sort results based on various criteria

Examples:
- "TABLE priority, due FROM #task WHERE !completed SORT due ASC" - Show incomplete tasks by priority
- "LIST FROM #meeting WHERE file.cday = date(today)" - Today's meeting notes
- "TABLE length(file.outlinks) AS Links FROM #project" - Count outlinks per project note

Note: Requires the Dataview plugin to be installed and enabled in Obsidian.`;

  // Create context for registration process
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianDataviewQueryTool",
      toolName: toolName,
      module: "ObsidianDataviewQueryRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration
      server.tool(
        toolName,
        toolDescription,
        DataviewQueryInputSchema.shape, // Provide the Zod schema shape for input definition
        /**
         * The handler function executed when the 'obsidian_dataview_query' tool is called.
         *
         * @param params - The input parameters received from the client, validated against the schema
         * @returns Promise resolving to the structured result for the MCP client
         */
        async (params: DataviewQueryInput) => {
          // Create a specific context for this handler invocation
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianDataviewQueryRequest",
              toolName: toolName,
              params: {
                queryLength: params.query?.length || 0,
                format: params.format,
                queryPreview: params.query?.substring(0, 50) || "",
              },
            });

          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block
          return await ErrorHandler.tryCatch(
            async () => {
              // Execute the dataview query logic
              const response: DataviewQueryResponse =
                await obsidianDataviewQueryLogic(
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
      operation: "registerObsidianDataviewQueryTool",
      context: registrationContext,
    },
  );
};