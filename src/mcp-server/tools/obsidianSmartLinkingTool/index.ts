/**
 * @fileoverview Obsidian Smart Linking MCP tool for intelligent link suggestions and smart linking.
 */

import { z } from "zod";

import { RequestContext, requestContextService } from "../../../utils/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";

import { obsidianSmartLinkingToolDefinition } from "./registration.js";
import { executeSmartLinkingOperation, SmartLinkingOperation } from "./logic.js";

/**
 * Zod schema for validating smart linking tool arguments.
 */
const SmartLinkingArgsSchema = z.object({
  operation: z.enum([
    "suggest_links_for_content",
    "find_link_opportunities", 
    "analyze_linkable_concepts",
    "suggest_backlinks",
    "recommend_tags",
    "find_broken_links",
    "get_link_suggestions"
  ]),
  filePath: z.string().optional(),
  content: z.string().optional(),
  maxSuggestions: z.number().min(1).max(50).default(10),
  similarityThreshold: z.number().min(0.1).max(1.0).default(0.3),
  includeExistingLinks: z.boolean().default(false),
  contextWindow: z.number().min(50).max(500).default(150),
  excludeFolders: z.array(z.string()).default([]),
  includeTagSuggestions: z.boolean().default(true),
});

/**
 * Registers the obsidian_smart_linking tool with the MCP server.
 */
export async function registerObsidianSmartLinkingTool(
  server: any,
  obsidianService: ObsidianRestApiService,
): Promise<void> {
  const toolName = "obsidian_smart_linking";
  const toolDescription = obsidianSmartLinkingToolDefinition.description;

  server.tool(
    toolName,
    toolDescription,
    SmartLinkingArgsSchema.shape,
    async (params: z.infer<typeof SmartLinkingArgsSchema>) => {
      const context = requestContextService.createRequestContext({
        operation: toolName,
      });
      
      const operation: SmartLinkingOperation = {
        operation: params.operation,
        filePath: params.filePath,
        content: params.content,
        maxSuggestions: params.maxSuggestions,
        similarityThreshold: params.similarityThreshold,
        includeExistingLinks: params.includeExistingLinks,
        contextWindow: params.contextWindow,
        excludeFolders: params.excludeFolders,
        includeTagSuggestions: params.includeTagSuggestions,
      };

      const result = await executeSmartLinkingOperation(operation, obsidianService, context);

      // Format the response
      let responseText = `## Smart Linking - ${result.operation}\\n\\n`;
      
      if (result.operation === "suggest_links_for_content" || 
          result.operation === "suggest_backlinks" || 
          result.operation === "get_link_suggestions") {
        responseText += `**Suggestions found:** ${result.suggestions?.length || 0}\\n`;
        if (result.filePath) {
          responseText += `**Source file:** ${result.filePath}\\n`;
        }
        responseText += `\\n`;
        
        if (result.suggestions && result.suggestions.length > 0) {
          responseText += `### Link Suggestions\\n`;
          responseText += `| Target Note | Type | Confidence | Reason |\\n`;
          responseText += `|-------------|------|-----------|--------|\\n`;
          
          result.suggestions.forEach(suggestion => {
            const confidence = `${Math.round(suggestion.confidence * 100)}%`;
            const type = suggestion.suggestionType.replace('_', ' ');
            const note = suggestion.targetNote.replace('.md', '');
            const reason = suggestion.reason.substring(0, 60) + (suggestion.reason.length > 60 ? '...' : '');
            
            responseText += `| **${note}** | ${type} | ${confidence} | ${reason} |\\n`;
          });
          
          responseText += `\\n`;
          
          // Show context for top suggestions
          const topSuggestions = result.suggestions.slice(0, 3);
          if (topSuggestions.some(s => s.context)) {
            responseText += `### Context Preview\\n`;
            topSuggestions.forEach(suggestion => {
              if (suggestion.context) {
                responseText += `**${suggestion.targetNote.replace('.md', '')}:**\\n`;
                responseText += `> ${suggestion.context.substring(0, 150)}...\\n\\n`;
              }
            });
          }
        }
      } else if (result.operation === "find_link_opportunities") {
        responseText += `**File:** ${result.filePath}\\n`;
        responseText += `**Opportunities found:** ${result.suggestions?.length || 0}\\n\\n`;
        
        if (result.suggestions && result.suggestions.length > 0) {
          responseText += `### Link Opportunities\\n`;
          result.suggestions.forEach(suggestion => {
            const note = suggestion.targetNote.replace('.md', '');
            responseText += `- **${note}**\\n`;
            responseText += `  - Confidence: ${Math.round(suggestion.confidence * 100)}%\\n`;
            responseText += `  - Reason: ${suggestion.reason}\\n`;
            if (suggestion.suggestedText) {
              responseText += `  - Suggested link: \`${suggestion.suggestedText}\`\\n`;
            }
            if (suggestion.context) {
              responseText += `  - Context: "${suggestion.context.substring(0, 100)}..."\\n`;
            }
            responseText += `\\n`;
          });
        }
      } else if (result.operation === "analyze_linkable_concepts") {
        responseText += `**Concepts analyzed:** ${result.concepts?.length || 0}\\n`;
        if (result.filePath) {
          responseText += `**Source file:** ${result.filePath}\\n`;
        }
        responseText += `\\n`;
        
        if (result.concepts && result.concepts.length > 0) {
          responseText += `### Key Concepts\\n`;
          responseText += `| Concept | Frequency | Importance | Related Notes | Tags |\\n`;
          responseText += `|---------|-----------|------------|---------------|------|\\n`;
          
          result.concepts.forEach(concept => {
            const relatedCount = concept.relatedNotes.length;
            const importance = Math.round(concept.importance);
            const tags = concept.suggestedTags.join(', ') || 'None';
            const relatedNotes = relatedCount > 0 ? `${relatedCount} notes` : 'None';
            
            responseText += `| **${concept.concept}** | ${concept.frequency} | ${importance} | ${relatedNotes} | ${tags} |\\n`;
          });
          
          responseText += `\\n`;
          
          // Show related notes for top concepts
          const topConcepts = result.concepts.slice(0, 3);
          topConcepts.forEach(concept => {
            if (concept.relatedNotes.length > 0) {
              responseText += `**${concept.concept}** related notes:\\n`;
              concept.relatedNotes.slice(0, 3).forEach(note => {
                responseText += `- ${note.replace('.md', '')}\\n`;
              });
              responseText += `\\n`;
            }
          });
        }
      } else if (result.operation === "recommend_tags") {
        responseText += `**Tags recommended:** ${result.tags?.length || 0}\\n`;
        if (result.filePath) {
          responseText += `**Source file:** ${result.filePath}\\n`;
        }
        responseText += `\\n`;
        
        if (result.tags && result.tags.length > 0) {
          responseText += `### Recommended Tags\\n`;
          result.tags.forEach(tag => {
            responseText += `- \`${tag}\`\\n`;
          });
        }
      } else if (result.operation === "find_broken_links") {
        responseText += `**File:** ${result.filePath}\\n`;
        responseText += `**Broken links found:** ${result.brokenLinks?.length || 0}\\n`;
        responseText += `**Total links checked:** ${result.statistics?.existingLinks || 0}\\n\\n`;
        
        if (result.brokenLinks && result.brokenLinks.length > 0) {
          responseText += `### Broken Links\\n`;
          result.brokenLinks.forEach(link => {
            responseText += `- ❌ \`[[${link}]]\`\\n`;
          });
        } else {
          responseText += `✅ No broken links found!\\n`;
        }
      }

      // Add statistics
      if (result.statistics) {
        responseText += `\\n### Statistics\\n`;
        responseText += `- Total suggestions: ${result.statistics.totalSuggestions}\\n`;
        responseText += `- High confidence (>70%): ${result.statistics.highConfidenceSuggestions}\\n`;
        if (result.statistics.conceptsAnalyzed > 0) {
          responseText += `- Concepts analyzed: ${result.statistics.conceptsAnalyzed}\\n`;
        }
        if (result.statistics.existingLinks > 0) {
          responseText += `- Existing links: ${result.statistics.existingLinks}\\n`;
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
export { obsidianSmartLinkingToolDefinition };