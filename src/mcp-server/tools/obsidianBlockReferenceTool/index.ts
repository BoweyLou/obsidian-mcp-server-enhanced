/**
 * @fileoverview Obsidian Block Reference MCP tool for working with headings and block references.
 */

import { z } from "zod";

import { RequestContext, requestContextService } from "../../../utils/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";

import { obsidianBlockReferenceToolDefinition } from "./registration.js";
import { executeBlockReferenceOperation, BlockReferenceOperation } from "./logic.js";

/**
 * Zod schema for validating block reference tool arguments.
 */
const BlockReferenceArgsSchema = z.object({
  operation: z.enum(["insert_under_heading", "create_block_reference", "get_heading_content", "list_headings", "get_block_content", "append_to_heading", "prepend_to_heading"]),
  filePath: z.string().min(1, "File path is required"),
  heading: z.string().optional(),
  headingLevel: z.number().min(1).max(6).optional(),
  content: z.string().optional(),
  blockId: z.string().optional(),
  position: z.enum(["start", "end", "after_heading", "before_next_heading"]).default("end"),
  createHeading: z.boolean().default(false),
  includeSubheadings: z.boolean().default(false),
});

/**
 * Registers the obsidian_block_reference tool with the MCP server.
 */
export async function registerObsidianBlockReferenceTool(
  server: any,
  obsidianService: ObsidianRestApiService,
): Promise<void> {
  const toolName = "obsidian_block_reference";
  const toolDescription = obsidianBlockReferenceToolDefinition.description;

  server.tool(
    toolName,
    toolDescription,
    BlockReferenceArgsSchema.shape,
    async (params: z.infer<typeof BlockReferenceArgsSchema>) => {
      const context = requestContextService.createRequestContext({
        operation: toolName,
      });
      
      const operation: BlockReferenceOperation = {
        operation: params.operation,
        filePath: params.filePath,
        heading: params.heading,
        headingLevel: params.headingLevel,
        content: params.content,
        blockId: params.blockId,
        position: params.position,
        createHeading: params.createHeading,
        includeSubheadings: params.includeSubheadings,
      };

      const result = await executeBlockReferenceOperation(operation, obsidianService, context);

      // Format the response
      let responseText = `## Block Reference - ${result.operation}\n\n`;
      
      if (result.operation === "list_headings") {
        responseText += `**File:** ${result.filePath}\n`;
        responseText += `**Headings found:** ${result.headings?.length || 0}\n\n`;
        if (result.headings && result.headings.length > 0) {
          result.headings.forEach(heading => {
            const indent = '  '.repeat(heading.level - 1);
            responseText += `${indent}${'#'.repeat(heading.level)} ${heading.text} (line ${heading.line})\n`;
          });
        }
      } else if (result.operation === "get_heading_content" || result.operation === "get_block_content") {
        responseText += `**File:** ${result.filePath}\n`;
        if (result.heading) {
          responseText += `**Heading:** ${result.heading}\n`;
        }
        if (result.blockId) {
          responseText += `**Block ID:** ^${result.blockId}\n`;
        }
        responseText += `**Content:**\n\n`;
        responseText += `\`\`\`markdown\n${result.content || ''}\n\`\`\``;
      } else {
        responseText += `**File:** ${result.filePath}\n`;
        if (result.heading) {
          responseText += `**Heading:** ${result.heading}\n`;
        }
        if (result.blockId) {
          responseText += `**Block ID:** ^${result.blockId}\n`;
        }
        responseText += `**Status:** ${result.message}\n`;
        
        if (result.created) {
          responseText += `- ✅ Heading created\n`;
        }
        if (result.inserted) {
          responseText += `- ✅ Content inserted\n`;
        }
      }

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };
    }
  );
}

// Export the tool definition
export { obsidianBlockReferenceToolDefinition };