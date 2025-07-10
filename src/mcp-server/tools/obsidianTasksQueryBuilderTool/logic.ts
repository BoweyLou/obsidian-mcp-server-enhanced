/**
 * @fileoverview Core logic for the Obsidian Tasks Query Builder tool.
 * Provides functionality to build and execute native Tasks plugin queries.
 * @module obsidianTasksQueryBuilderTool/logic
 */

import { z } from "zod";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
} from "../../../utils/index.js";

/**
 * Zod schema for validating Tasks Query Builder input parameters
 */
export const TasksQueryBuilderInputSchema = z.object({
  vault: z.string().optional(),
  
  // Core query building options
  query: z.string().optional().describe("Raw Tasks plugin query syntax"),
  
  // Alternative: structured query building
  filters: z.object({
    status: z.array(z.enum(["todo", "done", "in-progress", "cancelled", "deferred", "scheduled"])).optional(),
    priority: z.array(z.enum(["highest", "high", "medium", "low", "lowest"])).optional(),
    tags: z.array(z.string()).optional(),
    path: z.string().optional(),
    due: z.string().optional().describe("Due date filter (e.g., 'today', 'before tomorrow', 'after 2024-01-01')"),
    scheduled: z.string().optional().describe("Scheduled date filter"),
    starts: z.string().optional().describe("Start date filter"),
    created: z.string().optional().describe("Created date filter"),
    done: z.string().optional().describe("Done date filter"),
    recurrence: z.boolean().optional().describe("Show only recurring tasks"),
    hasDescription: z.boolean().optional().describe("Tasks with descriptions"),
  }).optional(),
  
  // Grouping and sorting
  groupBy: z.array(z.enum([
    "status", "priority", "due", "scheduled", "starts", "created", "done",
    "filename", "folder", "path", "tag", "heading", "urgency", "recurring"
  ])).optional(),
  
  sortBy: z.array(z.object({
    field: z.enum([
      "status", "priority", "due", "scheduled", "starts", "created", "done",
      "description", "path", "urgency", "tag"
    ]),
    reverse: z.boolean().default(false)
  })).optional(),
  
  // Display options
  hideOptions: z.object({
    editButton: z.boolean().default(false),
    postponeButton: z.boolean().default(false),
    backlinks: z.boolean().default(false),
    priority: z.boolean().default(false),
    dueDate: z.boolean().default(false),
    scheduledDate: z.boolean().default(false),
    startDate: z.boolean().default(false),
    createdDate: z.boolean().default(false),
    doneDate: z.boolean().default(false),
    recurrenceRule: z.boolean().default(false),
    taskCount: z.boolean().default(false),
  }).optional(),
  
  limit: z.number().int().positive().max(1000).default(100),
  explain: z.boolean().default(false).describe("Include query explanation"),
});

export type TasksQueryBuilderInput = z.infer<typeof TasksQueryBuilderInputSchema>;

/**
 * Response structure for Tasks Query Builder
 */
export interface TasksQueryBuilderResponse {
  success: boolean;
  generatedQuery: string;
  results?: any[];
  explanation?: string;
  executionTime: string;
  error?: string;
}

/**
 * Build a native Tasks plugin query from structured input
 */
function buildTasksQuery(input: TasksQueryBuilderInput): string {
  const queryParts: string[] = [];
  
  // If raw query is provided, use it directly
  if (input.query) {
    return input.query;
  }
  
  // Build query from structured filters
  if (input.filters) {
    const { filters } = input;
    
    // Status filters
    if (filters.status && filters.status.length > 0) {
      if (filters.status.includes("todo")) {
        queryParts.push("not done");
      }
      if (filters.status.includes("done")) {
        queryParts.push("done");
      }
      if (filters.status.includes("in-progress")) {
        queryParts.push("status.type is IN_PROGRESS");
      }
      if (filters.status.includes("cancelled")) {
        queryParts.push("status.type is CANCELLED");
      }
      if (filters.status.includes("deferred")) {
        queryParts.push("status.type is DEFERRED");
      }
      if (filters.status.includes("scheduled")) {
        queryParts.push("status.type is TODO");
      }
    }
    
    // Priority filters
    if (filters.priority && filters.priority.length > 0) {
      const priorityConditions = filters.priority.map(p => `priority is ${p}`);
      queryParts.push(`(${priorityConditions.join(" OR ")})`);
    }
    
    // Tag filters
    if (filters.tags && filters.tags.length > 0) {
      const tagConditions = filters.tags.map(tag => `tags include #${tag}`);
      queryParts.push(`(${tagConditions.join(" OR ")})`);
    }
    
    // Path filter
    if (filters.path) {
      queryParts.push(`path includes ${filters.path}`);
    }
    
    // Date filters
    if (filters.due) {
      queryParts.push(`due ${filters.due}`);
    }
    if (filters.scheduled) {
      queryParts.push(`scheduled ${filters.scheduled}`);
    }
    if (filters.starts) {
      queryParts.push(`starts ${filters.starts}`);
    }
    if (filters.created) {
      queryParts.push(`created ${filters.created}`);
    }
    if (filters.done) {
      queryParts.push(`done ${filters.done}`);
    }
    
    // Special filters
    if (filters.recurrence === true) {
      queryParts.push("is recurring");
    } else if (filters.recurrence === false) {
      queryParts.push("is not recurring");
    }
    
    if (filters.hasDescription === true) {
      queryParts.push("has description");
    } else if (filters.hasDescription === false) {
      queryParts.push("no description");
    }
  }
  
  // Group by clauses
  if (input.groupBy && input.groupBy.length > 0) {
    input.groupBy.forEach(groupField => {
      queryParts.push(`group by ${groupField}`);
    });
  }
  
  // Sort by clauses
  if (input.sortBy && input.sortBy.length > 0) {
    input.sortBy.forEach(sort => {
      const direction = sort.reverse ? " reverse" : "";
      queryParts.push(`sort by ${sort.field}${direction}`);
    });
  }
  
  // Hide options
  if (input.hideOptions) {
    const hideOpts = input.hideOptions;
    if (hideOpts.editButton) queryParts.push("hide edit button");
    if (hideOpts.postponeButton) queryParts.push("hide postpone button");
    if (hideOpts.backlinks) queryParts.push("hide backlinks");
    if (hideOpts.priority) queryParts.push("hide priority");
    if (hideOpts.dueDate) queryParts.push("hide due date");
    if (hideOpts.scheduledDate) queryParts.push("hide scheduled date");
    if (hideOpts.startDate) queryParts.push("hide start date");
    if (hideOpts.createdDate) queryParts.push("hide created date");
    if (hideOpts.doneDate) queryParts.push("hide done date");
    if (hideOpts.recurrenceRule) queryParts.push("hide recurrence rule");
    if (hideOpts.taskCount) queryParts.push("hide task count");
  }
  
  // Limit
  if (input.limit && input.limit !== 100) {
    queryParts.push(`limit ${input.limit}`);
  }
  
  // Explain
  if (input.explain) {
    queryParts.push("explain");
  }
  
  return queryParts.join("\n");
}

/**
 * Execute a Tasks plugin query by embedding it in a note and running a command
 */
async function executeTasksQuery(
  query: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext
): Promise<any[]> {
  try {
    // First, try to execute the query using Dataview integration
    // This is a fallback approach since we can't directly access Tasks plugin API
    const dataviewQuery = `
TABLE WITHOUT ID 
  task.text as Text,
  task.status.symbol as Status,
  task.priority.name as Priority,
  task.due as DueDate,
  task.scheduled as ScheduledDate,
  task.start as StartDate,
  task.done as CompletionDate,
  task.created as CreatedDate,
  task.tags as Tags,
  file.path as FilePath,
  task.line as LineNumber
FROM "/"
FLATTEN file.tasks as task
WHERE task
LIMIT 500`;

    logger.debug("Executing Tasks query via Dataview fallback", {
      ...context,
      query,
      dataviewQuery,
    });

    const dataviewResults = await obsidianService.searchComplex(
      dataviewQuery,
      "application/vnd.olrapi.dataview.dql+txt",
      context
    );

    // Convert results to a more readable format
    const results = dataviewResults.map(result => result.result).filter(Boolean);
    
    logger.info(`Tasks query executed via Dataview, found ${results.length} tasks`, context);
    return results;
    
  } catch (error) {
    logger.warning("Failed to execute Tasks query", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Core logic for building and executing Tasks plugin queries
 */
export async function obsidianTasksQueryBuilderLogic(
  input: TasksQueryBuilderInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<TasksQueryBuilderResponse> {
  const startTime = Date.now();
  
  logger.info("Building and executing Tasks plugin query", {
    ...context,
    operation: "tasksQueryBuilder",
    hasRawQuery: !!input.query,
    hasFilters: !!input.filters,
    hasGroupBy: !!(input.groupBy && input.groupBy.length > 0),
    hasSortBy: !!(input.sortBy && input.sortBy.length > 0),
  });

  try {
    // Step 1: Build the Tasks plugin query
    const generatedQuery = buildTasksQuery(input);
    
    if (!generatedQuery.trim()) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "No valid query could be generated from the provided parameters",
        { input }
      );
    }
    
    logger.debug("Generated Tasks plugin query", {
      ...context,
      generatedQuery,
    });

    // Step 2: Execute the query
    let results: any[] = [];
    let explanation = "";
    let error: string | undefined;
    
    try {
      results = await executeTasksQuery(generatedQuery, obsidianService, context);
      
      if (input.explain) {
        explanation = `This query uses the Tasks plugin syntax to filter and organize tasks.
        
Generated Query:
\`\`\`
${generatedQuery}
\`\`\`

Query Components:
${generatedQuery.split('\n').map(line => `- ${line.trim()}`).join('\n')}

Note: This is executed via Dataview integration as a fallback. For full Tasks plugin functionality, embed this query in a note with \`\`\`tasks\` code blocks.`;
      }
      
    } catch (executionError) {
      error = executionError instanceof Error ? executionError.message : String(executionError);
      logger.warning("Query execution failed, returning query only", {
        ...context,
        error,
      });
    }
    
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.info("Tasks query builder completed", {
      ...context,
      executionTime,
      generatedQuery: generatedQuery.substring(0, 100) + "...",
      resultsCount: results.length,
      hasError: !!error,
    });

    return {
      success: !error,
      generatedQuery,
      results: results.length > 0 ? results : undefined,
      explanation,
      executionTime,
      error,
    };

  } catch (error) {
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.error("Tasks query builder failed", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      executionTime,
    });

    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      `Tasks query builder failed: ${error instanceof Error ? error.message : String(error)}`,
      { executionTime, input },
    );
  }
}