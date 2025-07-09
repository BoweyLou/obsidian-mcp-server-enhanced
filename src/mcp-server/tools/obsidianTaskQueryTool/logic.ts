/**
 * @fileoverview Enhanced core logic for the Obsidian Task Query tool.
 * Provides comprehensive functionality to search and analyze tasks across the Obsidian vault
 * with full support for Obsidian Tasks plugin syntax and metadata.
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
import * as chrono from "chrono-node";

/**
 * Task status enumeration with full Obsidian Tasks plugin support
 */
export const TaskStatus = {
  INCOMPLETE: "incomplete",
  COMPLETED: "completed",
  IN_PROGRESS: "in-progress", 
  CANCELLED: "cancelled",
  DEFERRED: "deferred",
  SCHEDULED: "scheduled",
  ALL: "all",
} as const;

export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];

/**
 * Task checkbox character mapping for Obsidian Tasks plugin
 */
export const TASK_STATUS_CHARS = {
  [TaskStatus.INCOMPLETE]: [' ', ''],
  [TaskStatus.COMPLETED]: ['x', 'X'],
  [TaskStatus.IN_PROGRESS]: ['/', '\\'],
  [TaskStatus.CANCELLED]: ['-'],
  [TaskStatus.DEFERRED]: ['>'],
  [TaskStatus.SCHEDULED]: ['<'],
} as const;

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
    TaskStatus.DEFERRED,
    TaskStatus.SCHEDULED,
    TaskStatus.ALL,
  ]).default(TaskStatus.ALL),
  
  dateRange: z.enum([
    "today",
    "yesterday", 
    "tomorrow",
    "this-week",
    "next-week",
    "last-week",
    "this-month",
    "next-month",
    "last-month",
    "overdue",
    "upcoming",
    "all-time",
  ]).default("all-time"),
  
  folder: z.string().optional(),
  
  tags: z.array(z.string()).optional(),
  
  priority: z.enum(["highest", "high", "medium", "low", "lowest", "all"]).default("all"),
  
  format: z.enum([
    OutputFormat.LIST,
    OutputFormat.TABLE,
    OutputFormat.SUMMARY,
  ]).default(OutputFormat.LIST),
  
  limit: z.number().int().positive().max(500).default(100),
});

export type TaskQueryInput = z.infer<typeof TaskQueryInputSchema>;

/**
 * Individual task item structure with full Obsidian Tasks plugin support
 */
export interface TaskItem {
  text: string;
  status: TaskStatusType;
  statusChar: string;
  filePath: string;
  lineNumber: number;
  indentLevel: number;
  
  // Obsidian Tasks plugin metadata
  priority?: "highest" | "high" | "medium" | "low" | "lowest";
  dueDate?: string;
  scheduledDate?: string;
  startDate?: string;
  completionDate?: string;
  createdDate?: string;
  
  // Recurring task info
  recurrence?: string;
  
  // Tags and projects
  tags: string[];
  project?: string;
  
  // Additional metadata
  description?: string;
  urgency?: number;
  
  // Context
  parentTask?: string;
  subtasks?: TaskItem[];
  hasSubtasks: boolean;
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
    deferredCount: number;
    scheduledCount: number;
    overdueCount: number;
    highPriorityCount: number;
    filesSearched: number;
  };
  executionTime: string;
  formattedOutput: string;
}

/**
 * Parse task status from markdown checkbox with full Obsidian Tasks plugin support
 */
function parseTaskStatus(statusChar: string): TaskStatusType {
  const char = statusChar.trim();
  
  // Check against all known status characters
  for (const [status, chars] of Object.entries(TASK_STATUS_CHARS)) {
    if ((chars as readonly string[]).includes(char)) {
      return status as TaskStatusType;
    }
  }
  
  // Additional checks for common variations
  switch (char.toLowerCase()) {
    case 'x':
      return TaskStatus.COMPLETED;
    case '/':
    case '\\':
      return TaskStatus.IN_PROGRESS;
    case '-':
      return TaskStatus.CANCELLED;
    case '>':
      return TaskStatus.DEFERRED;
    case '<':
      return TaskStatus.SCHEDULED;
    case ' ':
    case '':
    default:
      return TaskStatus.INCOMPLETE;
  }
}

/**
 * Extract comprehensive task metadata with full Obsidian Tasks plugin support
 */
function extractTaskMetadata(taskText: string): {
  priority?: "highest" | "high" | "medium" | "low" | "lowest";
  dueDate?: string;
  scheduledDate?: string;
  startDate?: string;
  completionDate?: string;
  createdDate?: string;
  recurrence?: string;
  description?: string;
  project?: string;
  tags: string[];
  urgency?: number;
} {
  const metadata = {
    tags: [] as string[],
  } as any;

  // Extract Obsidian Tasks plugin priority indicators
  // Highest: 🔺 or ⏫
  if (taskText.match(/🔺|⏫/)) metadata.priority = "highest";
  // High: 🔴, ‼️, ❗, 🅘, 🚨, ⬆️
  else if (taskText.match(/🔴|‼️|❗|🅘|🚨|⬆️/)) metadata.priority = "high";
  // Medium: 🟡, 🟠, ➡️, ◀️, ▶️
  else if (taskText.match(/🟡|🟠|➡️|◀️|▶️/)) metadata.priority = "medium";
  // Low: 🔵, 🟢, ⬇️, 🔽
  else if (taskText.match(/🔵|🟢|⬇️|🔽/)) metadata.priority = "low";
  // Lowest: 🔻 or ⏬
  else if (taskText.match(/🔻|⏬/)) metadata.priority = "lowest";

  // Extract dates with Obsidian Tasks plugin emojis
  // Due date: 📅 YYYY-MM-DD
  const dueDateMatch = taskText.match(/📅\s*(\d{4}-\d{2}-\d{2})/i);
  if (dueDateMatch) metadata.dueDate = dueDateMatch[1];

  // Scheduled date: ⏳ YYYY-MM-DD
  const scheduledDateMatch = taskText.match(/⏳\s*(\d{4}-\d{2}-\d{2})/i);
  if (scheduledDateMatch) metadata.scheduledDate = scheduledDateMatch[1];

  // Start date: 🛫 YYYY-MM-DD
  const startDateMatch = taskText.match(/🛫\s*(\d{4}-\d{2}-\d{2})/i);
  if (startDateMatch) metadata.startDate = startDateMatch[1];

  // Completion/Done date: ✅ YYYY-MM-DD
  const completionDateMatch = taskText.match(/✅\s*(\d{4}-\d{2}-\d{2})/i);
  if (completionDateMatch) metadata.completionDate = completionDateMatch[1];

  // Created date: ➕ YYYY-MM-DD
  const createdDateMatch = taskText.match(/➕\s*(\d{4}-\d{2}-\d{2})/i);
  if (createdDateMatch) metadata.createdDate = createdDateMatch[1];

  // Recurrence: 🔁 every [period]
  const recurrenceMatch = taskText.match(/🔁\s*(.+?)(?=\s|$|📅|⏳|🛫|✅|➕|#)/i);
  if (recurrenceMatch) metadata.recurrence = recurrenceMatch[1].trim();

  // Extract description (text after dates and emojis, before tags)
  let description = taskText;
  // Remove all the date and metadata tokens
  description = description.replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/✅\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/➕\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/🔁\s*[^📅⏳🛫✅➕#]+/g, '');
  description = description.replace(/🔺|⏫|🔴|‼️|❗|🅘|🚨|⬆️|🟡|🟠|➡️|◀️|▶️|🔵|🟢|⬇️|🔽|🔻|⏬/g, '');
  description = description.replace(/#[\w\/\-]+/g, ''); // Remove tags
  metadata.description = description.trim();

  // Extract project tags (#project/name or #project)
  const projectMatches = taskText.match(/#(project(?:\/[\w-]+)?)/i);
  if (projectMatches) metadata.project = projectMatches[1];

  // Extract all tags (#tag)
  const tagMatches = taskText.match(/#[\w\/\-]+/g);
  if (tagMatches) {
    metadata.tags = tagMatches.map(tag => tag.slice(1)); // Remove # prefix
  }

  // Calculate urgency score based on priority and due date proximity
  if (metadata.priority && metadata.dueDate) {
    const priorityScores = { "highest": 10, "high": 8, "medium": 5, "low": 3, "lowest": 1 };
    const dueDate = new Date(metadata.dueDate);
    const today = new Date();
    const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    
    let urgencyScore = priorityScores[metadata.priority as keyof typeof priorityScores] || 0;
    if (daysUntilDue < 0) urgencyScore += 5; // Overdue bonus
    else if (daysUntilDue <= 1) urgencyScore += 3; // Due soon bonus
    else if (daysUntilDue <= 7) urgencyScore += 1; // Due this week bonus
    
    metadata.urgency = urgencyScore;
  }

  return metadata;
}

/**
 * Parse tasks from markdown content with enhanced Obsidian Tasks plugin support
 */
function parseTasksFromContent(
  content: string,
  filePath: string,
  statusFilter: TaskStatusType,
): TaskItem[] {
  const lines = content.split('\n');
  const tasks: TaskItem[] = [];
  const taskStack: { task: TaskItem; indentLevel: number }[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Enhanced regex to support different list markers (-, *, 1., etc.)
    const taskMatch = line.match(/^(\s*)([*+-]|\d+\.)\s*\[(.)\]\s*(.+)$/);
    
    if (taskMatch) {
      const [, whitespace, listMarker, statusChar, taskText] = taskMatch;
      const indentLevel = whitespace.length;
      const status = parseTaskStatus(statusChar);
      
      // Filter by status if not "all"
      if (statusFilter !== TaskStatus.ALL && status !== statusFilter) {
        continue;
      }
      
      const metadata = extractTaskMetadata(taskText);
      
      const task: TaskItem = {
        text: taskText.trim(),
        status,
        statusChar,
        filePath,
        lineNumber: i + 1,
        indentLevel,
        hasSubtasks: false,
        ...metadata,
      };
      
      // Handle task hierarchy
      // Remove tasks from stack that are at same or greater indent level
      while (taskStack.length > 0 && taskStack[taskStack.length - 1].indentLevel >= indentLevel) {
        taskStack.pop();
      }
      
      // If there's a parent task, link this as a subtask
      if (taskStack.length > 0) {
        const parent = taskStack[taskStack.length - 1].task;
        if (!parent.subtasks) parent.subtasks = [];
        parent.subtasks.push(task);
        parent.hasSubtasks = true;
        task.parentTask = parent.text;
      }
      
      // Add current task to stack and results
      taskStack.push({ task, indentLevel });
      tasks.push(task);
    }
  }
  
  return tasks;
}

/**
 * Enhanced date utilities for task filtering
 */
function parseRelativeDate(dateString: string): Date | null {
  const parsed = chrono.parseDate(dateString);
  return parsed || null;
}

function isTaskFromTodaysFile(filePath: string): boolean {
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + 
                   String(today.getMonth() + 1).padStart(2, '0') + '-' + 
                   String(today.getDate()).padStart(2, '0'); // YYYY-MM-DD
  
  // Check various daily note patterns
  const patterns = [
    todayStr, // YYYY-MM-DD
    today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0'), // YYYYMMDD
    `${today.getDate()}-${today.getMonth() + 1}-${today.getFullYear()}`, // DD-MM-YYYY
    `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`, // MM/DD/YYYY
  ];
  
  return patterns.some(pattern => filePath.includes(pattern));
}

function getDateRangeFilter(dateRange: string): (date: Date) => boolean {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  switch (dateRange) {
    case "today":
      return (date: Date) => {
        const taskDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        return taskDate.getTime() === today.getTime();
      };
    
    case "yesterday":
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return (date: Date) => {
        const taskDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        return taskDate.getTime() === yesterday.getTime();
      };
    
    case "tomorrow":
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return (date: Date) => {
        const taskDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        return taskDate.getTime() === tomorrow.getTime();
      };
    
    case "this-week":
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      const weekEnd = new Date(today);
      weekEnd.setDate(today.getDate() + (6 - today.getDay()));
      return (date: Date) => date >= weekStart && date <= weekEnd;
    
    case "next-week":
      const nextWeekStart = new Date(today);
      nextWeekStart.setDate(today.getDate() + (7 - today.getDay()));
      const nextWeekEnd = new Date(nextWeekStart);
      nextWeekEnd.setDate(nextWeekStart.getDate() + 6);
      return (date: Date) => date >= nextWeekStart && date <= nextWeekEnd;
    
    case "overdue":
      return (date: Date) => date < today;
    
    case "upcoming":
      const upcoming = new Date(today);
      upcoming.setDate(today.getDate() + 7);
      return (date: Date) => date > today && date <= upcoming;
    
    default:
      return () => true;
  }
}

/**
 * Enhanced task filtering by date range with intelligent date selection
 */
function filterTasksByDate(tasks: TaskItem[], dateRange: string, statusFilter: TaskStatusType): TaskItem[] {
  if (dateRange === "all-time") return tasks;
  
  const dateFilter = getDateRangeFilter(dateRange);
  
  return tasks.filter(task => {
    let taskDate: Date | null = null;
    let shouldIncludeBasedOnFile = false;
    
    // Smart date selection based on task status and available dates
    if (task.status === TaskStatus.COMPLETED && task.completionDate) {
      // For completed tasks, use completion date if available
      taskDate = new Date(task.completionDate);
    } else if (task.status === TaskStatus.SCHEDULED && task.scheduledDate) {
      // For scheduled tasks, use scheduled date
      taskDate = new Date(task.scheduledDate);
    } else if (task.dueDate) {
      // For other tasks, use due date if available
      taskDate = new Date(task.dueDate);
    } else if (task.startDate) {
      // Fallback to start date
      taskDate = new Date(task.startDate);
    } else if (task.createdDate) {
      // Fallback to created date
      taskDate = new Date(task.createdDate);
    }
    
    // For today/yesterday queries, also include tasks from daily note files
    if (["today", "yesterday", "tomorrow"].includes(dateRange)) {
      shouldIncludeBasedOnFile = isTaskFromTodaysFile(task.filePath);
    }
    
    // Include based on file date
    if (shouldIncludeBasedOnFile) {
      return true;
    }
    
    // If no specific dates available, exclude from date-based filtering
    if (!taskDate || isNaN(taskDate.getTime())) {
      return false;
    }
    
    return dateFilter(taskDate);
  });
}

/**
 * Format tasks for output
 */
function formatTaskOutput(tasks: TaskItem[], format: OutputFormatType, summary: any): string {
  switch (format) {
    case OutputFormat.TABLE:
      if (tasks.length === 0) return "No tasks found.";
      
      let table = "| Status | Task | File | Priority | Due Date | Tags |\n";
      table += "|--------|------|------|----------|----------|------|\n";
      
      for (const task of tasks) {
        const statusIcon = task.status === TaskStatus.COMPLETED ? "✅" : 
                          task.status === TaskStatus.IN_PROGRESS ? "🔄" :
                          task.status === TaskStatus.CANCELLED ? "❌" :
                          task.status === TaskStatus.DEFERRED ? "📤" :
                          task.status === TaskStatus.SCHEDULED ? "⏰" : "⏳";
        const priority = task.priority ? `${task.priority}` : "-";
        const dueDate = task.dueDate || "-";
        const fileName = task.filePath.split('/').pop() || task.filePath;
        const tags = task.tags.length > 0 ? task.tags.slice(0, 3).join(", ") : "-";
        
        table += `| ${statusIcon} | ${task.text.substring(0, 50)}${task.text.length > 50 ? '...' : ''} | ${fileName} | ${priority} | ${dueDate} | ${tags} |\n`;
      }
      
      return table;
      
    case OutputFormat.SUMMARY:
      return `## Task Summary

**Total Tasks**: ${summary.totalTasks}
- ⏳ Incomplete: ${summary.incompleteCount}
- ✅ Completed: ${summary.completedCount}  
- 🔄 In Progress: ${summary.inProgressCount}
- ❌ Cancelled: ${summary.cancelledCount}
- 📤 Deferred: ${summary.deferredCount}
- ⏰ Scheduled: ${summary.scheduledCount}

**Special Categories**:
- 🚨 Overdue: ${summary.overdueCount}
- ⭐ High Priority: ${summary.highPriorityCount}

**Files Searched**: ${summary.filesSearched}
${tasks.length > 0 ? `\n**Sample Tasks**:\n${tasks.slice(0, 5).map(t => `- ${t.status === TaskStatus.COMPLETED ? '✅' : '⏳'} ${t.text}`).join('\n')}` : ''}`;

    case OutputFormat.LIST:
    default:
      if (tasks.length === 0) return "No tasks found.";
      
      return tasks.map(task => {
        const statusIcon = task.status === TaskStatus.COMPLETED ? "✅" : 
                          task.status === TaskStatus.IN_PROGRESS ? "🔄" :
                          task.status === TaskStatus.CANCELLED ? "❌" :
                          task.status === TaskStatus.DEFERRED ? "📤" :
                          task.status === TaskStatus.SCHEDULED ? "⏰" : "⏳";
        const priority = task.priority ? ` [${task.priority}]` : "";
        const dueDate = task.dueDate ? ` 📅 ${task.dueDate}` : "";
        const tags = task.tags.length > 0 ? ` #${task.tags.join(" #")}` : "";
        const fileName = task.filePath.split('/').pop() || task.filePath;
        
        return `${statusIcon} ${task.text}${priority}${dueDate}${tags} (${fileName}:${task.lineNumber})`;
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
  
  logger.info("Executing enhanced task query", {
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
    // Step 1: Enhanced search strategy - try Dataview first, fallback to simple search
    let searchResults = new Map<string, any>();
    
    // Try Dataview query for more efficient task discovery
    try {
      const dataviewQuery = `
TABLE WITHOUT ID file.link as File, length(file.tasks) as Tasks
WHERE length(file.tasks) > 0
SORT file.name ASC
LIMIT 100`;
      
      const dataviewResults = await obsidianService.searchComplex(
        dataviewQuery,
        "application/vnd.olrapi.dataview.dql+txt",
        context
      );
      
      // Convert Dataview results to our search format
      for (const searchResult of dataviewResults) {
        if (searchResult.result && searchResult.result.File) {
          const filename = searchResult.result.File.replace(/\[\[(.+)\]\]/, '$1');
          searchResults.set(filename, { filename, match: searchResult.result });
        } else if (searchResult.filename) {
          // Fallback to using the filename directly
          searchResults.set(searchResult.filename, searchResult);
        }
      }
      
      logger.info(`Found ${searchResults.size} files with tasks via Dataview`, context);
      
    } catch (dataviewError) {
      logger.info("Dataview query failed, falling back to simple search", {
        ...context,
        error: dataviewError instanceof Error ? dataviewError.message : String(dataviewError),
      });
      
      // Fallback to simple search with enhanced patterns
      const taskPatterns = [
        "- [ ]", "- [x]", "- [/]", "- [-]", "- [>]", "- [<]",
        "* [ ]", "* [x]", "* [/]", "* [-]", "* [>]", "* [<]",
        "1. [ ]", "1. [x]", "1. [/]", "1. [-]", "1. [>]", "1. [<]"
      ];
      
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

    // Step 5: Enhanced sorting with multiple criteria
    filteredTasks.sort((a, b) => {
      // First sort by urgency if available
      if (a.urgency !== undefined && b.urgency !== undefined) {
        const urgencyDiff = b.urgency - a.urgency; // Higher urgency first
        if (urgencyDiff !== 0) return urgencyDiff;
      }
      
      // Then sort by due date (overdue first, then by proximity)
      if (a.dueDate && b.dueDate) {
        const dateA = new Date(a.dueDate);
        const dateB = new Date(b.dueDate);
        const dateDiff = dateA.getTime() - dateB.getTime();
        if (dateDiff !== 0) return dateDiff;
      }
      
      // Then by priority
      const priorityOrder = { "highest": 5, "high": 4, "medium": 3, "low": 2, "lowest": 1 };
      const priorityA = priorityOrder[a.priority as keyof typeof priorityOrder] || 0;
      const priorityB = priorityOrder[b.priority as keyof typeof priorityOrder] || 0;
      const priorityDiff = priorityB - priorityA;
      if (priorityDiff !== 0) return priorityDiff;
      
      // Finally by file path and line number
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
      deferredCount: filteredTasks.filter(t => t.status === TaskStatus.DEFERRED).length,
      scheduledCount: filteredTasks.filter(t => t.status === TaskStatus.SCHEDULED).length,
      overdueCount: filteredTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date()).length,
      highPriorityCount: filteredTasks.filter(t => ['highest', 'high'].includes(t.priority || '')).length,
      filesSearched,
    };

    // Step 7: Format output
    const formattedOutput = formatTaskOutput(limitedTasks, input.format, summary);
    
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.info("Enhanced task query executed successfully", {
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
    
    logger.error("Enhanced task query execution failed", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      executionTime,
    });

    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      `Enhanced task query failed: ${error instanceof Error ? error.message : String(error)}`,
      { executionTime, input },
    );
  }
}