/**
 * @fileoverview Registration configuration for the Obsidian Graph Analysis tool.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool definition for analyzing Obsidian note connections and relationships.
 */
export const obsidianGraphAnalysisToolDefinition: Tool = {
  name: "obsidian_graph_analysis",
  description: `Analyze note connections and relationships in your Obsidian vault.

Key capabilities:
- Find all notes linked to/from a specific note
- Analyze backlinks and forward links
- Discover orphaned notes (no connections)
- Find highly connected hub notes
- Trace connection paths between notes
- Analyze tag relationships and co-occurrences
- Generate connection statistics and metrics

Perfect for understanding your knowledge graph structure, finding related content, and optimizing note organization.
Helps identify knowledge gaps, content clusters, and navigation patterns.`,

  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "get_note_links", 
          "get_backlinks", 
          "find_orphaned_notes", 
          "find_hub_notes", 
          "trace_connection_path", 
          "analyze_tag_relationships",
          "get_vault_stats"
        ],
        description: "Type of graph analysis to perform",
      },
      filePath: {
        type: "string",
        description: "Path to the target note (required for note-specific operations)",
      },
      targetNote: {
        type: "string", 
        description: "Target note path for path tracing operations",
      },
      minConnections: {
        type: "number",
        minimum: 1,
        default: 5,
        description: "Minimum number of connections for hub note analysis",
      },
      includeTagLinks: {
        type: "boolean",
        default: true,
        description: "Whether to include tag-based connections in analysis",
      },
      includeFolderStructure: {
        type: "boolean",
        default: false,
        description: "Whether to include folder-based relationships",
      },
      maxDepth: {
        type: "number",
        minimum: 1,
        maximum: 10,
        default: 3,
        description: "Maximum depth for connection path tracing",
      },
    },
    required: ["operation"],
    additionalProperties: false,
  },
};