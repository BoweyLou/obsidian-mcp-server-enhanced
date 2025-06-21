/**
 * @fileoverview Registration configuration for the Obsidian Template System tool.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool definition for managing Obsidian templates and template-based file creation.
 */
export const obsidianTemplateSystemToolDefinition: Tool = {
  name: "obsidian_template_system",
  description: `Manage Obsidian templates and create files from templates.

Key capabilities:
- List available templates in your vault
- Create new files from existing templates
- Apply template variables and placeholders
- Support for date/time variables ({{date}}, {{time}}, etc.)
- Custom variable substitution
- Template validation and preview
- Batch template application

Perfect for creating consistent note structures, daily notes, project templates, and standardized content formats.
Supports both simple text replacement and advanced templating with variables.`,

  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "list_templates",
          "get_template",
          "create_from_template", 
          "preview_template",
          "validate_template",
          "apply_template_variables"
        ],
        description: "Template operation to perform",
      },
      templatePath: {
        type: "string",
        description: "Path to the template file (required for template-specific operations)",
      },
      targetPath: {
        type: "string",
        description: "Path where the new file should be created (for create_from_template)",
      },
      templateFolder: {
        type: "string",
        default: "Templates",
        description: "Folder containing templates (defaults to 'Templates')",
      },
      variables: {
        type: "object",
        description: "Key-value pairs for template variable substitution",
        additionalProperties: {
          type: "string"
        }
      },
      autoGenerateVariables: {
        type: "boolean",
        default: true,
        description: "Whether to auto-generate date/time variables",
      },
      createFolders: {
        type: "boolean",
        default: true,
        description: "Whether to create parent folders if they don't exist",
      },
      overwriteExisting: {
        type: "boolean",
        default: false,
        description: "Whether to overwrite existing files when creating from template",
      },
    },
    required: ["operation"],
    additionalProperties: false,
  },
};