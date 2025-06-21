/**
 * @fileoverview Obsidian Periodic Notes MCP tool for managing daily, weekly, monthly, and other periodic notes.
 */

import { z } from "zod";

import { RequestContext, requestContextService } from "../../../utils/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";

import { obsidianPeriodicNotesToolDefinition } from "./registration.js";
import { executePeriodicNotesOperation, PeriodicNotesOperation } from "./logic.js";

/**
 * Zod schema for validating periodic notes tool arguments.
 */
const PeriodicNotesArgsSchema = z.object({
  operation: z.enum(["get", "create", "append", "update", "list_periods", "exists"]),
  period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]).optional(),
  content: z.string().optional(),
  date: z.string().optional(),
  format: z.enum(["markdown", "json"]).default("markdown"),
  template: z.string().optional(),
  createIfNotExists: z.boolean().default(false),
});


/**
 * Registers the obsidian_periodic_notes tool with the MCP server.
 */
export async function registerObsidianPeriodicNotesTool(
  server: any,
  obsidianService: ObsidianRestApiService,
): Promise<void> {
  const toolName = "obsidian_periodic_notes";
  const toolDescription = obsidianPeriodicNotesToolDefinition.description;

  server.tool(
    toolName,
    toolDescription,
    PeriodicNotesArgsSchema.shape,
    async (params: z.infer<typeof PeriodicNotesArgsSchema>) => {
      const context = requestContextService.createRequestContext({
        operation: toolName,
      });
      
      const operation: PeriodicNotesOperation = {
        operation: params.operation,
        period: params.period,
        content: params.content,
        date: params.date,
        format: params.format,
        template: params.template,
        createIfNotExists: params.createIfNotExists,
      };

      const result = await executePeriodicNotesOperation(operation, obsidianService, context);

      // Format the response
      let responseText = `## Periodic Notes - ${result.operation}\n\n`;
      
      if (result.operation === "list_periods") {
        responseText += `**Available periodic note types:**\n`;
        result.availablePeriods?.forEach(period => {
          responseText += `- ${period}\n`;
        });
      } else if (result.operation === "exists") {
        responseText += `**Period:** ${result.period}\n`;
        responseText += `**Exists:** ${result.exists ? "Yes" : "No"}\n`;
        if (result.message) {
          responseText += `\n${result.message}`;
        }
      } else if (result.operation === "get") {
        responseText += `**Period:** ${result.period}\n`;
        responseText += `**Content:**\n\n`;
        if (typeof result.content === "string") {
          responseText += `\`\`\`markdown\n${result.content}\n\`\`\``;
        } else {
          responseText += `\`\`\`json\n${JSON.stringify(result.content, null, 2)}\n\`\`\``;
        }
      } else {
        responseText += `**Period:** ${result.period}\n`;
        responseText += `**Status:** ${result.message}\n`;
        
        if (result.created) {
          responseText += `- ✅ Note created\n`;
        }
        if (result.appended) {
          responseText += `- ✅ Content appended\n`;
        }
      }

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };
    }
  );
}

// Export the tool definition and handler
export { obsidianPeriodicNotesToolDefinition };