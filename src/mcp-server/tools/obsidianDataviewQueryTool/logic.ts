/**
 * @fileoverview Business logic for the Obsidian Dataview Query tool.
 * Handles execution of Dataview DQL queries via the Obsidian REST API.
 * @module obsidianDataviewQueryTool/logic
 */

import { z } from "zod";
import { logger, RequestContext } from "../../../utils/index.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { ComplexSearchResult } from "../../../services/obsidianRestAPI/types.js";

/**
 * Input validation schema for the Dataview query tool.
 */
export const DataviewQueryInputSchema = z.object({
  query: z
    .string()
    .min(1, "Query cannot be empty")
    .refine(
      (query) => {
        const trimmed = query.trim().toUpperCase();
        return trimmed.startsWith("TABLE") || 
               trimmed.startsWith("LIST") || 
               trimmed.startsWith("TASK") ||
               trimmed.startsWith("CALENDAR");
      },
      "Query must start with TABLE, LIST, TASK, or CALENDAR (Dataview DQL keywords)"
    ),
  format: z.enum(["table", "list", "raw"]).default("table"),
});

/**
 * Type definition for validated input.
 */
export type DataviewQueryInput = z.infer<typeof DataviewQueryInputSchema>;

/**
 * Interface for formatted query results.
 */
export interface DataviewQueryResponse {
  success: boolean;
  resultCount: number;
  query: string;
  format: string;
  data: string | object;
  executionTime?: string;
  error?: string;
}

/**
 * Formats Dataview query results based on the requested format.
 */
function formatQueryResults(
  results: ComplexSearchResult[],
  format: string,
  query: string
): DataviewQueryResponse {
  const resultCount = results.length;
  
  if (resultCount === 0) {
    return {
      success: true,
      resultCount: 0,
      query,
      format,
      data: format === "raw" ? [] : "No results found for the query.",
    };
  }

  switch (format) {
    case "raw":
      return {
        success: true,
        resultCount,
        query,
        format,
        data: results,
      };

    case "list":
      const listItems = results.map((result, index) => {
        const title = result.filename || `Result ${index + 1}`;
        // Note: ComplexSearchResult only has filename and result fields
        const content = result.result 
          ? (typeof result.result === "string" ? result.result.substring(0, 100) : JSON.stringify(result.result).substring(0, 100))
          : "";
        const suffix = content.length > 100 ? "..." : "";
        return `• **${title}**${content ? ` - ${content}${suffix}` : ""}`;
      });
      
      return {
        success: true,
        resultCount,
        query,
        format,
        data: `Query Results (${resultCount} items):\n\n${listItems.join("\n")}`,
      };

    case "table":
    default:
      // Create a formatted table view
      const tableHeader = "| File | Result |\n|------|--------|";
      const tableRows = results.map((result) => {
        const filename = result.filename || "Unknown";
        const resultData = result.result 
          ? (typeof result.result === "string" 
             ? result.result.substring(0, 80).replace(/\|/g, "\\|").replace(/\n/g, " ")
             : JSON.stringify(result.result).substring(0, 80).replace(/\|/g, "\\|").replace(/\n/g, " "))
          : "N/A";
        
        return `| ${filename} | ${resultData}${resultData.length >= 80 ? "..." : ""} |`;
      });

      const tableData = `Query Results (${resultCount} items):\n\n${tableHeader}\n${tableRows.join("\n")}`;
      
      return {
        success: true,
        resultCount,
        query,
        format,
        data: tableData,
      };
  }
}

/**
 * Executes a Dataview DQL query against the Obsidian vault.
 * 
 * @param obsidianService - The Obsidian REST API service instance
 * @param input - The validated input containing the query and format
 * @param context - Request context for logging and error handling
 * @returns Promise resolving to formatted query results
 */
export async function executeDataviewQuery(
  obsidianService: ObsidianRestApiService,
  input: DataviewQueryInput,
  context: RequestContext,
): Promise<DataviewQueryResponse> {
  const startTime = Date.now();
  
  try {
    logger.info("Executing Dataview DQL query", {
      ...context,
      operation: "dataviewQuery",
      queryLength: input.query.length,
      format: input.format,
      queryPreview: input.query.substring(0, 100),
    });

    // Execute the Dataview query using the existing searchComplex method
    const results = await obsidianService.searchComplex(
      input.query,
      "application/vnd.olrapi.dataview.dql+txt",
      context
    );

    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.info("Dataview query executed successfully", {
      ...context,
      operation: "dataviewQuery",
      resultCount: results.length,
      executionTime,
    });

    // Format the results based on the requested format
    const formattedResult = formatQueryResults(results, input.format, input.query);
    formattedResult.executionTime = executionTime;

    return formattedResult;

  } catch (error) {
    const executionTime = `${Date.now() - startTime}ms`;
    
    // Handle specific Dataview-related errors
    if (error instanceof Error) {
      // Check for common Dataview errors
      if (error.message.includes("Dataview") || error.message.includes("DQL")) {
        logger.warning("Dataview query execution failed - likely plugin not installed or query syntax error", {
          ...context,
          operation: "dataviewQuery",
          error: error.message,
          executionTime,
        });
        
        return {
          success: false,
          resultCount: 0,
          query: input.query,
          format: input.format,
          data: "Dataview query failed. Please ensure:\n" +
                "1. The Dataview plugin is installed and enabled in Obsidian\n" +
                "2. Your query syntax is valid DQL\n" +
                "3. The query type (TABLE/LIST/TASK) matches your data\n\n" +
                `Error: ${error.message}`,
          executionTime,
          error: error.message,
        };
      }
    }

    // Re-throw for other types of errors (authentication, network, etc.)
    throw error;
  }
}

/**
 * Main logic function for the Obsidian Dataview Query tool.
 * Validates input, executes the query, and returns formatted results.
 * 
 * @param input - The input arguments from the MCP client
 * @param context - Request context for logging and error handling
 * @param obsidianService - The Obsidian REST API service instance
 * @returns Promise resolving to the tool execution result
 */
export async function obsidianDataviewQueryLogic(
  input: DataviewQueryInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<DataviewQueryResponse> {
  logger.debug("Processing Dataview query input", {
    ...context,
    operation: "dataviewQuery",
    hasQuery: !!input.query,
    format: input.format,
  });

  // Execute the query
  const result = await executeDataviewQuery(obsidianService, input, context);
  
  return result;
}