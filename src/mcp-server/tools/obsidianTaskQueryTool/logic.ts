/**
 * @fileoverview Core logic for the Obsidian Task Query tool.
 * Provides functionality to search and analyze tasks across the Obsidian vault.
 * @module obsidianTaskQueryTool/logic
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
 * Task status enumeration
 */
export const TaskStatus = {
  INCOMPLETE: "incomplete",
  COMPLETED: "completed",
  IN_PROGRESS: "in-progress", 
  CANCELLED: "cancelled",
  ALL: "all",
} as const;

export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];

/**
 * Output format enumeration
 */
export const OutputFormat = {
  LIST: "list",
  TABLE: "table", 
  SUMMARY: "summary",
} as const;

export type OutputFormatType = typeof OutputFormat[keyof typeof OutputFormat];

/**
 * Zod schema for validating task query input parameters
 */
export const TaskQueryInputSchema = z.object({
  status: z.enum([
    TaskStatus.INCOMPLETE,
    TaskStatus.COMPLETED,
    TaskStatus.IN_PROGRESS,
    TaskStatus.CANCELLED,
    TaskStatus.ALL,
  ]).default(TaskStatus.ALL),
  
  dateRange: z.enum([
    "today",
    "yesterday", 
    "this-week",
    "last-week",
    "this-month",
    "last-month",
    "all-time",
  ]).default("all-time"),
  
  folder: z.string().optional(),
  
  tags: z.array(z.string()).optional(),
  
  priority: z.enum(["high", "medium", "low", "all"]).default("all"),
  
  format: z.enum([
    OutputFormat.LIST,
    OutputFormat.TABLE,
    OutputFormat.SUMMARY,
  ]).default(OutputFormat.LIST),
  
  limit: z.number().int().positive().max(500).default(100),
});

export type TaskQueryInput = z.infer<typeof TaskQueryInputSchema>;

/**
 * Individual task item structure
 */
export interface TaskItem {
  text: string;
  status: TaskStatusType;
  filePath: string;
  lineNumber: number;
  priority?: "high" | "medium" | "low";
  dueDate?: string;
  completionDate?: string;
  createdDate?: string;
  project?: string;
  tags: string[];
}

/**
 * Task query response structure
 */
export interface TaskQueryResponse {
  success: boolean;
  query: {
    status: TaskStatusType;
    dateRange: string;
    folder?: string;
    tags?: string[];
    priority: string;
    format: OutputFormatType;
    limit: number;
  };
  results: TaskItem[];
  summary: {
    totalTasks: number;
    incompleteCount: number;
    completedCount: number;
    inProgressCount: number;
    cancelledCount: number;
    filesSearched: number;
  };
  executionTime: string;
  formattedOutput: string;
}

/**
 * Parse task status from markdown checkbox
 */
function parseTaskStatus(checkbox: string): TaskStatusType {
  const char = checkbox.trim().toLowerCase();
  
  switch (char) {
    case "[ ]":
    case " ":
      return TaskStatus.INCOMPLETE;
    case "[x]":
    case "x":
      return TaskStatus.COMPLETED;
    case "[/]":
    case "/":
      return TaskStatus.IN_PROGRESS;
    case "[-]":
    case "-":
      return TaskStatus.CANCELLED;
    default:
      return TaskStatus.INCOMPLETE;
  }
}

/**
 * Extract task metadata from task text
 */
function extractTaskMetadata(taskText: string): {
  priority?: "high" | "medium" | "low";
  dueDate?: string;
  completionDate?: string;
  project?: string;
  tags: string[];
} {
  const metadata = {
    tags: [] as string[],
  } as any;

  // Extract priority (various formats)
  // High: 🔴, ‼️, !!!, ❗, HIGH, 🔥
  if (taskText.match(/🔴|‼️|!!!|❗|HIGH|🔥/i)) metadata.priority = "high";
  // Medium: 🟡, !!, MEDIUM, 🟠
  else if (taskText.match(/🟡|!!|MEDIUM|🟠/i)) metadata.priority = "medium";
  // Low: 🟢, !, LOW, 🔵
  else if (taskText.match(/🟢|!|LOW|🔵/i)) metadata.priority = "low";

  // Extract due date (obsidian-tasks format: 📅 YYYY-MM-DD)
  const dueDateMatch = taskText.match(/(?:📅|due:?|@due\(?)\s*(\d{4}-\d{2}-\d{2})/i);
  if (dueDateMatch) metadata.dueDate = dueDateMatch[1];

  // Extract completion date (multiple formats)
  // ✅ YYYY-MM-DD, Completed: YYYY-MM-DD, Done: YYYY-MM-DD, finished YYYY-MM-DD
  const completionDateMatch = taskText.match(/(?:✅|\u2713|completed:?|done:?|finished:?)\s*(\d{4}-\d{2}-\d{2})/i);
  if (completionDateMatch) metadata.completionDate = completionDateMatch[1];

  // Extract project (#project/name or project:: name)
  const projectMatch = taskText.match(/#(project\/[\w-]+)|project::\s*([\w-]+)/i);
  if (projectMatch) metadata.project = projectMatch[1] || projectMatch[2];

  // Extract tags (#tag)
  const tagMatches = taskText.match(/#[\w\/\-]+/g);
  if (tagMatches) {
    metadata.tags = tagMatches.map(tag => tag.slice(1)); // Remove # prefix
  }

  return metadata;
}

/**
 * Parse tasks from markdown content
 */
function parseTasksFromContent(
  content: string,
  filePath: string,
  statusFilter: TaskStatusType,
): TaskItem[] {
  const lines = content.split('\n');
  const tasks: TaskItem[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const taskMatch = line.match(/^(\s*)-\s*\[(.)\]\s*(.+)$/);
    
    if (taskMatch) {
      const [, indent, statusChar, taskText] = taskMatch;
      const status = parseTaskStatus(`[${statusChar}]`);
      
      // Filter by status if not "all"
      if (statusFilter !== TaskStatus.ALL && status !== statusFilter) {
        continue;
      }
      
      const metadata = extractTaskMetadata(taskText);
      
      tasks.push({
        text: taskText.trim(),
        status,
        filePath,
        lineNumber: i + 1,
        ...metadata,
      });
    }
  }
  
  return tasks;
}

/**
 * Check if a task is from today based on file path (daily note pattern)
 */
function isTaskFromTodaysFile(filePath: string): boolean {
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + 
                   String(today.getMonth() + 1).padStart(2, '0') + '-' + 
                   String(today.getDate()).padStart(2, '0'); // YYYY-MM-DD
  
  // Check if file path contains today's date (common in daily notes)
  return filePath.includes(todayStr);
}

/**
 * Filter tasks by date range
 */
function filterTasksByDate(tasks: TaskItem[], dateRange: string, statusFilter: TaskStatusType): TaskItem[] {
  if (dateRange === "all-time") return tasks;
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  return tasks.filter(task => {
    let taskDate: Date | null = null;
    let shouldIncludeBasedOnFile = false;
    
    // For completed tasks, prioritize completion date
    if (task.status === TaskStatus.COMPLETED && task.completionDate) {
      taskDate = new Date(task.completionDate);
    }
    // For incomplete tasks, use due date
    else if (task.status === TaskStatus.INCOMPLETE && task.dueDate) {
      taskDate = new Date(task.dueDate);
    }
    // For "today" queries on completed tasks without explicit completion dates,
    // include tasks from today's daily note files
    else if (dateRange === "today" && task.status === TaskStatus.COMPLETED) {
      shouldIncludeBasedOnFile = isTaskFromTodaysFile(task.filePath);
    }
    // For "today" queries on incomplete tasks, include tasks from today's files or with due dates
    else if (dateRange === "today" && task.status === TaskStatus.INCOMPLETE) {
      shouldIncludeBasedOnFile = isTaskFromTodaysFile(task.filePath);
      if (task.dueDate) {
        taskDate = new Date(task.dueDate);
      }
    }
    
    // If we should include based on file date, do so
    if (shouldIncludeBasedOnFile) {
      return true;
    }
    
    // If no specific dates available, exclude from date-based filtering
    if (!taskDate || isNaN(taskDate.getTime())) {
      return dateRange === "all-time";
    }
    
    switch (dateRange) {
      case "today":
        return taskDate.toDateString() === today.toDateString();
      case "yesterday":
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        return taskDate.toDateString() === yesterday.toDateString();
      case "this-week":
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());
        const weekEnd = new Date(today);
        weekEnd.setDate(today.getDate() + (6 - today.getDay()));
        return taskDate >= weekStart && taskDate <= weekEnd;
      case "last-week":
        const lastWeekEnd = new Date(today);
        lastWeekEnd.setDate(today.getDate() - today.getDay() - 1);
        const lastWeekStart = new Date(lastWeekEnd);
        lastWeekStart.setDate(lastWeekEnd.getDate() - 6);
        return taskDate >= lastWeekStart && taskDate <= lastWeekEnd;
      case "this-month":
        return taskDate.getMonth() === today.getMonth() && taskDate.getFullYear() === today.getFullYear();
      case "last-month":
        const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        return taskDate.getMonth() === lastMonth.getMonth() && taskDate.getFullYear() === lastMonth.getFullYear();
      default:
        return true;
    }
  });
}

/**
 * Format tasks for output
 */
function formatTaskOutput(tasks: TaskItem[], format: OutputFormatType, summary: any): string {
  switch (format) {
    case OutputFormat.TABLE:
      if (tasks.length === 0) return "No tasks found.";
      
      let table = "| Status | Task | File | Priority | Due Date |\n";
      table += "|--------|------|------|----------|----------|\n";
      
      for (const task of tasks) {
        const statusIcon = task.status === TaskStatus.COMPLETED ? "✅" : 
                          task.status === TaskStatus.IN_PROGRESS ? "🔄" :
                          task.status === TaskStatus.CANCELLED ? "❌" : "⏳";
        const priority = task.priority ? `${task.priority}` : "-";
        const dueDate = task.dueDate || "-";
        const fileName = task.filePath.split('/').pop() || task.filePath;
        
        table += `| ${statusIcon} | ${task.text.substring(0, 50)}${task.text.length > 50 ? '...' : ''} | ${fileName} | ${priority} | ${dueDate} |\n`;
      }
      
      return table;
      
    case OutputFormat.SUMMARY:
      return `## Task Summary

**Total Tasks**: ${summary.totalTasks}
- ⏳ Incomplete: ${summary.incompleteCount}
- ✅ Completed: ${summary.completedCount}  
- 🔄 In Progress: ${summary.inProgressCount}
- ❌ Cancelled: ${summary.cancelledCount}

**Files Searched**: ${summary.filesSearched}
${tasks.length > 0 ? `\n**Sample Tasks**:\n${tasks.slice(0, 5).map(t => `- ${t.status === TaskStatus.COMPLETED ? '✅' : '⏳'} ${t.text}`).join('\n')}` : ''}`;

    case OutputFormat.LIST:
    default:
      if (tasks.length === 0) return "No tasks found.";
      
      return tasks.map(task => {
        const statusIcon = task.status === TaskStatus.COMPLETED ? "✅" : 
                          task.status === TaskStatus.IN_PROGRESS ? "🔄" :
                          task.status === TaskStatus.CANCELLED ? "❌" : "⏳";
        const priority = task.priority ? ` [${task.priority}]` : "";
        const dueDate = task.dueDate ? ` 📅 ${task.dueDate}` : "";
        const fileName = task.filePath.split('/').pop() || task.filePath;
        
        return `${statusIcon} ${task.text}${priority}${dueDate} (${fileName}:${task.lineNumber})`;
      }).join('\n');
  }
}

/**
 * Core logic for executing task queries
 */
export async function obsidianTaskQueryLogic(
  input: TaskQueryInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<TaskQueryResponse> {
  const startTime = Date.now();
  
  logger.info("Executing task query", {
    ...context,
    operation: "taskQuery",
    params: {
      status: input.status,
      dateRange: input.dateRange,
      format: input.format,
      folder: input.folder,
      tagsCount: input.tags?.length || 0,
      priority: input.priority,
      limit: input.limit,
    },
  });

  try {
    // Step 1: Search for files containing task patterns
    const taskPatterns = ["- [ ]", "- [x]", "- [/]", "- [-]"];
    const searchResults = new Map<string, any>();
    
    for (const pattern of taskPatterns) {
      try {
        const results = await obsidianService.searchSimple(pattern, 50, context);
        for (const result of results) {
          if (!searchResults.has(result.filename)) {
            searchResults.set(result.filename, result);
          }
        }
      } catch (searchError) {
        logger.warning(`Failed to search for pattern "${pattern}"`, {
          ...context,
          error: searchError instanceof Error ? searchError.message : String(searchError),
        });
      }
    }

    // Step 2: Filter files by folder if specified
    let filesToProcess = Array.from(searchResults.values());
    if (input.folder) {
      filesToProcess = filesToProcess.filter(file => 
        file.filename.startsWith(input.folder)
      );
    }

    // Step 3: Process each file to extract and parse tasks
    const allTasks: TaskItem[] = [];
    let filesSearched = 0;
    
    for (const fileResult of filesToProcess.slice(0, Math.min(50, filesToProcess.length))) {
      try {
        filesSearched++;
        const fileContent = await obsidianService.getFileContent(fileResult.filename, "markdown", context);
        const tasks = parseTasksFromContent(typeof fileContent === "string" ? fileContent : fileContent.content, fileResult.filename, input.status);
        allTasks.push(...tasks);
      } catch (fileError) {
        logger.warning(`Failed to read file: ${fileResult.filename}`, {
          ...context,
          error: fileError instanceof Error ? fileError.message : String(fileError),
        });
      }
    }

    // Step 4: Apply additional filters
    let filteredTasks = allTasks;
    
    // Filter by date range
    filteredTasks = filterTasksByDate(filteredTasks, input.dateRange, input.status);
    
    // Filter by priority
    if (input.priority !== "all") {
      filteredTasks = filteredTasks.filter(task => task.priority === input.priority);
    }
    
    // Filter by tags (if any task tags match the requested tags)
    if (input.tags && input.tags.length > 0) {
      filteredTasks = filteredTasks.filter(task => 
        input.tags!.some(tag => task.tags.includes(tag))
      );
    }

    // Step 5: Apply limit and sort by file path, then line number
    filteredTasks.sort((a, b) => {
      const fileCompare = a.filePath.localeCompare(b.filePath);
      return fileCompare !== 0 ? fileCompare : a.lineNumber - b.lineNumber;
    });
    
    const limitedTasks = filteredTasks.slice(0, input.limit);

    // Step 6: Generate summary statistics
    const summary = {
      totalTasks: filteredTasks.length,
      incompleteCount: filteredTasks.filter(t => t.status === TaskStatus.INCOMPLETE).length,
      completedCount: filteredTasks.filter(t => t.status === TaskStatus.COMPLETED).length,
      inProgressCount: filteredTasks.filter(t => t.status === TaskStatus.IN_PROGRESS).length,
      cancelledCount: filteredTasks.filter(t => t.status === TaskStatus.CANCELLED).length,
      filesSearched,
    };

    // Step 7: Format output
    const formattedOutput = formatTaskOutput(limitedTasks, input.format, summary);
    
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.info("Task query executed successfully", {
      ...context,
      executionTime,
      totalTasks: summary.totalTasks,
      filesSearched: summary.filesSearched,
    });

    return {
      success: true,
      query: {
        status: input.status,
        dateRange: input.dateRange,
        folder: input.folder,
        tags: input.tags,
        priority: input.priority,
        format: input.format,
        limit: input.limit,
      },
      results: limitedTasks,
      summary,
      executionTime,
      formattedOutput,
    };

  } catch (error) {
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.error("Task query execution failed", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      executionTime,
    });

    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      `Task query failed: ${error instanceof Error ? error.message : String(error)}`,
      { executionTime, input },
    );
  }
}