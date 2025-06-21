/**
 * @fileoverview Obsidian Template System MCP tool for managing templates and template-based file creation.
 */

import { z } from "zod";

import { RequestContext, requestContextService } from "../../../utils/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";

import { obsidianTemplateSystemToolDefinition } from "./registration.js";
import { executeTemplateSystemOperation, TemplateSystemOperation } from "./logic.js";

/**
 * Zod schema for validating template system tool arguments.
 */
const TemplateSystemArgsSchema = z.object({
  operation: z.enum([
    "list_templates",
    "get_template",
    "create_from_template", 
    "preview_template",
    "validate_template",
    "apply_template_variables"
  ]),
  templatePath: z.string().optional(),
  targetPath: z.string().optional(),
  templateFolder: z.string().default("Templates"),
  variables: z.record(z.string()).optional(),
  autoGenerateVariables: z.boolean().default(true),
  createFolders: z.boolean().default(true),
  overwriteExisting: z.boolean().default(false),
});

/**
 * Registers the obsidian_template_system tool with the MCP server.
 */
export async function registerObsidianTemplateSystemTool(
  server: any,
  obsidianService: ObsidianRestApiService,
): Promise<void> {
  const toolName = "obsidian_template_system";
  const toolDescription = obsidianTemplateSystemToolDefinition.description;

  server.tool(
    toolName,
    toolDescription,
    TemplateSystemArgsSchema.shape,
    async (params: z.infer<typeof TemplateSystemArgsSchema>) => {
      const context = requestContextService.createRequestContext({
        operation: toolName,
      });
      
      const operation: TemplateSystemOperation = {
        operation: params.operation,
        templatePath: params.templatePath,
        targetPath: params.targetPath,
        templateFolder: params.templateFolder,
        variables: params.variables || {},
        autoGenerateVariables: params.autoGenerateVariables,
        createFolders: params.createFolders,
        overwriteExisting: params.overwriteExisting,
      };

      const result = await executeTemplateSystemOperation(operation, obsidianService, context);

      // Format the response
      let responseText = `## Template System - ${result.operation}\\n\\n`;
      
      if (result.operation === "list_templates") {
        responseText += `**Templates found:** ${result.templates?.length || 0}\\n\\n`;
        
        if (result.templates && result.templates.length > 0) {
          responseText += `| Template | Variables | Size | Preview |\\n`;
          responseText += `|----------|-----------|------|---------|\\n`;
          
          result.templates.forEach(template => {
            const variables = template.variables.length > 0 
              ? template.variables.slice(0, 3).join(', ') + (template.variables.length > 3 ? '...' : '')
              : 'None';
            const preview = template.previewContent?.substring(0, 50).replace(/\\n/g, ' ') || '';
            const size = `${Math.round(template.size / 1024 * 100) / 100}KB`;
            
            responseText += `| **${template.name}** | ${variables} | ${size} | ${preview}... |\\n`;
          });
        }
      } else if (result.operation === "get_template") {
        responseText += `**Template:** ${result.templatePath}\\n`;
        responseText += `**Variables found:** ${result.variables?.length || 0}\\n\\n`;
        
        if (result.variables && result.variables.length > 0) {
          responseText += `### Variables\\n`;
          result.variables.forEach(variable => {
            responseText += `- \`{{${variable}}}\`\\n`;
          });
          responseText += `\\n`;
        }
        
        if (result.content) {
          responseText += `### Template Content\\n`;
          responseText += "```markdown\\n" + result.content + "\\n```";
        }
      } else if (result.operation === "create_from_template") {
        responseText += `**Template:** ${result.templatePath}\\n`;
        responseText += `**Created:** ${result.targetPath}\\n`;
        responseText += `**Status:** ${result.created ? '✅ Success' : '❌ Failed'}\\n`;
      } else if (result.operation === "preview_template" || result.operation === "apply_template_variables") {
        responseText += `**Template:** ${result.templatePath}\\n\\n`;
        
        if (result.content) {
          responseText += `### Processed Content\\n`;
          responseText += "```markdown\\n" + result.content + "\\n```";
        }
      } else if (result.operation === "validate_template") {
        responseText += `**Template:** ${result.templatePath}\\n`;
        responseText += `**Status:** ${result.success ? '✅ Valid' : '❌ Invalid'}\\n`;
        responseText += `**Variables found:** ${result.variables?.length || 0}\\n\\n`;
        
        if (result.variables && result.variables.length > 0) {
          responseText += `### Variables\\n`;
          result.variables.forEach(variable => {
            responseText += `- \`{{${variable}}}\`\\n`;
          });
          responseText += `\\n`;
        }
        
        if (result.validationErrors && result.validationErrors.length > 0) {
          responseText += `### Validation Errors\\n`;
          result.validationErrors.forEach(error => {
            responseText += `- ❌ ${error}\\n`;
          });
        }
      }

      responseText += `\\n---\\n*${result.message}*`;

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };
    }
  );
}

// Export the tool definition
export { obsidianTemplateSystemToolDefinition };