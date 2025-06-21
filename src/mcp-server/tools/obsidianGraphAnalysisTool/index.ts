/**
 * @fileoverview Obsidian Graph Analysis MCP tool for analyzing note connections and relationships.
 */

import { z } from "zod";

import { RequestContext, requestContextService } from "../../../utils/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";

import { obsidianGraphAnalysisToolDefinition } from "./registration.js";
import { executeGraphAnalysisOperation, GraphAnalysisOperation } from "./logic.js";

/**
 * Zod schema for validating graph analysis tool arguments.
 */
const GraphAnalysisArgsSchema = z.object({
  operation: z.enum([
    "get_note_links", 
    "get_backlinks", 
    "find_orphaned_notes", 
    "find_hub_notes", 
    "trace_connection_path", 
    "analyze_tag_relationships",
    "get_vault_stats"
  ]),
  filePath: z.string().optional(),
  targetNote: z.string().optional(),
  minConnections: z.number().min(1).default(5),
  includeTagLinks: z.boolean().default(true),
  includeFolderStructure: z.boolean().default(false),
  maxDepth: z.number().min(1).max(10).default(3),
});

/**
 * Registers the obsidian_graph_analysis tool with the MCP server.
 */
export async function registerObsidianGraphAnalysisTool(
  server: any,
  obsidianService: ObsidianRestApiService,
): Promise<void> {
  const toolName = "obsidian_graph_analysis";
  const toolDescription = obsidianGraphAnalysisToolDefinition.description;

  server.tool(
    toolName,
    toolDescription,
    GraphAnalysisArgsSchema.shape,
    async (params: z.infer<typeof GraphAnalysisArgsSchema>) => {
      const context = requestContextService.createRequestContext({
        operation: toolName,
      });
      
      const operation: GraphAnalysisOperation = {
        operation: params.operation,
        filePath: params.filePath,
        targetNote: params.targetNote,
        minConnections: params.minConnections,
        includeTagLinks: params.includeTagLinks,
        includeFolderStructure: params.includeFolderStructure,
        maxDepth: params.maxDepth,
      };

      const result = await executeGraphAnalysisOperation(operation, obsidianService, context);

      // Format the response
      let responseText = `## Graph Analysis - ${result.operation}\\n\\n`;
      
      if (result.operation === "get_note_links" || result.operation === "get_backlinks") {
        responseText += `**File:** ${result.filePath}\\n`;
        responseText += `**Connections found:** ${result.connections?.length || 0}\\n\\n`;
        
        if (result.connections && result.connections.length > 0) {
          const groupedConnections = result.connections.reduce((acc, conn) => {
            if (!acc[conn.type]) acc[conn.type] = [];
            acc[conn.type].push(conn);
            return acc;
          }, {} as Record<string, typeof result.connections>);

          Object.entries(groupedConnections).forEach(([type, connections]) => {
            responseText += `### ${type.replace('_', ' ').toUpperCase()} (${connections.length})\\n`;
            connections.forEach(conn => {
              responseText += `- **${conn.target}**`;
              if (conn.context) {
                responseText += ` - *"${conn.context.substring(0, 100)}${conn.context.length > 100 ? '...' : ''}"*`;
              }
              responseText += `\\n`;
            });
            responseText += `\\n`;
          });
        }
      } else if (result.operation === "find_orphaned_notes" || result.operation === "find_hub_notes") {
        responseText += `**Notes found:** ${result.notes?.length || 0}\\n\\n`;
        
        if (result.notes && result.notes.length > 0) {
          responseText += `| Note | Outgoing Links | Incoming Links | Tags | Folder |\\n`;
          responseText += `|------|----------------|----------------|------|--------|\\n`;
          
          result.notes.forEach(note => {
            const noteName = note.name;
            const outgoing = note.outgoingLinks;
            const incoming = note.incomingLinks;
            const tags = note.tags.slice(0, 3).join(', ') + (note.tags.length > 3 ? '...' : '');
            const folder = note.folder || 'Root';
            
            responseText += `| ${noteName} | ${outgoing} | ${incoming} | ${tags} | ${folder} |\\n`;
          });
        }
      } else if (result.operation === "trace_connection_path") {
        responseText += `**Source:** ${result.filePath}\\n`;
        responseText += `**Target:** ${operation.targetNote}\\n`;
        responseText += `**Path found:** ${result.path && result.path.length > 0 ? 'Yes' : 'No'}\\n\\n`;
        
        if (result.path && result.path.length > 0) {
          responseText += `### Connection Path (${result.path.length - 1} hops)\\n`;
          result.path.forEach((note, index) => {
            if (index === 0) {
              responseText += `🟢 **${note}** (start)\\n`;
            } else if (index === result.path!.length - 1) {
              responseText += `🎯 **${note}** (target)\\n`;
            } else {
              responseText += `↳ **${note}**\\n`;
            }
          });
        } else {
          responseText += `No connection path found within ${operation.maxDepth} hops.\\n`;
        }
      } else if (result.operation === "analyze_tag_relationships") {
        responseText += `**Analysis completed**\\n\\n`;
        
        if (result.statistics?.tagDistribution) {
          const sortedTags = Object.entries(result.statistics.tagDistribution)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 20);
          
          responseText += `### Top Tags\\n`;
          responseText += `| Tag | Usage Count |\\n`;
          responseText += `|-----|-------------|\\n`;
          sortedTags.forEach(([tag, count]) => {
            responseText += `| ${tag} | ${count} |\\n`;
          });
        }
      } else if (result.operation === "get_vault_stats") {
        responseText += `### Vault Overview\\n\\n`;
        
        if (result.statistics) {
          const stats = result.statistics;
          responseText += `- **Total Notes:** ${stats.totalNotes}\\n`;
          responseText += `- **Total Connections:** ${stats.totalConnections}\\n`;
          responseText += `- **Average Connections per Note:** ${stats.averageConnections}\\n`;
          responseText += `- **Orphaned Notes:** ${stats.orphanedNotes}\\n`;
          responseText += `- **Most Connected Note:** ${stats.mostConnectedNote || 'N/A'}\\n`;
          responseText += `- **Unique Tags:** ${Object.keys(stats.tagDistribution || {}).length}\\n\\n`;
          
          if (stats.tagDistribution) {
            const topTags = Object.entries(stats.tagDistribution)
              .sort(([,a], [,b]) => b - a)
              .slice(0, 10);
            
            if (topTags.length > 0) {
              responseText += `### Top 10 Tags\\n`;
              topTags.forEach(([tag, count], index) => {
                responseText += `${index + 1}. **${tag}** (${count} notes)\\n`;
              });
            }
          }
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
export { obsidianGraphAnalysisToolDefinition };