/**
 * @fileoverview Registration configuration for the Obsidian Periodic Notes tool.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool definition for managing Obsidian periodic notes (daily, weekly, monthly, etc.).
 */
export const obsidianPeriodicNotesToolDefinition: Tool = {
  name: "obsidian_periodic_notes",
  description: `Manage Obsidian periodic notes (daily, weekly, monthly, quarterly, yearly).
  
Key capabilities:
- Get current or specific period notes
- Create new periodic notes from templates
- Append content to existing periodic notes
- List available periods and check note existence

Supports all Obsidian periodic note types: daily, weekly, monthly, quarterly, yearly.
Perfect for daily journaling, weekly reviews, monthly planning, and temporal organization.`,

  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["get", "create", "append", "update", "list_periods", "exists"],
        description: "Operation to perform on periodic notes",
      },
      period: {
        type: "string",
        enum: ["daily", "weekly", "monthly", "quarterly", "yearly"],
        description: "Type of periodic note (required for most operations)",
      },
      content: {
        type: "string",
        description: "Content to write or append (for create/update/append operations)",
      },
      date: {
        type: "string",
        description: "Specific date for the note (ISO format YYYY-MM-DD). If not provided, uses current date",
      },
      format: {
        type: "string",
        enum: ["markdown", "json"],
        default: "markdown",
        description: "Return format for get operations",
      },
      template: {
        type: "string",
        description: "Template name or content to use when creating new notes",
      },
      createIfNotExists: {
        type: "boolean",
        default: false,
        description: "Whether to create the note if it doesn't exist (for append operations)",
      },
    },
    required: ["operation"],
    additionalProperties: false,
  },
};