/**
 * @fileoverview Registration configuration for the Obsidian Block Reference tool.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool definition for managing Obsidian block references and heading-based operations.
 */
export const obsidianBlockReferenceToolDefinition: Tool = {
  name: "obsidian_block_reference",
  description: `Work with Obsidian block references and heading-based content operations.
  
Key capabilities:
- Insert content under specific headings in notes
- Create and manage block references (^block-id)
- Extract content from specific headings or blocks
- Navigate document structure by headings
- Append/prepend content to sections

Perfect for structured note editing, creating cross-references, and organizing content within large documents.
Supports both heading navigation (## Heading Name) and block reference operations (^block-id).`,

  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["insert_under_heading", "create_block_reference", "get_heading_content", "list_headings", "get_block_content", "append_to_heading", "prepend_to_heading"],
        description: "Operation to perform with block references or headings",
      },
      filePath: {
        type: "string",
        description: "Path to the target file (relative to vault root)",
      },
      heading: {
        type: "string",
        description: "Heading name to target (for heading-based operations)",
      },
      headingLevel: {
        type: "number",
        minimum: 1,
        maximum: 6,
        description: "Heading level (1-6) for heading operations, defaults to auto-detect",
      },
      content: {
        type: "string",
        description: "Content to insert, append, or prepend",
      },
      blockId: {
        type: "string",
        description: "Block ID for block reference operations (without ^)",
      },
      position: {
        type: "string",
        enum: ["start", "end", "after_heading", "before_next_heading"],
        default: "end",
        description: "Where to insert content relative to the heading or block",
      },
      createHeading: {
        type: "boolean",
        default: false,
        description: "Whether to create the heading if it doesn't exist",
      },
      includeSubheadings: {
        type: "boolean",
        default: false,
        description: "Whether to include content from subheadings when getting content",
      },
    },
    required: ["operation", "filePath"],
    additionalProperties: false,
  },
};