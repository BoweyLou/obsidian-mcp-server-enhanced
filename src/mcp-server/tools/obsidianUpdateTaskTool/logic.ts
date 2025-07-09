/**
 * @fileoverview Core logic for the Obsidian Update Task tool.
 * Provides functionality to modify existing tasks in Obsidian with full Tasks plugin metadata support.
 * @module obsidianUpdateTaskTool/logic
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
 * Task update input schema with comprehensive modification options
 */
export const UpdateTaskInputSchema = z.object({
  // Task identification
  filePath: z.string(),
  lineNumber: z.number().int().positive().optional(),
  taskText: z.string().optional(), // For finding task by text match
  
  // Update operations
  operation: z.enum([
    "toggle-status",
    "set-status", 
    "update-text",
    "set-priority",
    "set-due-date",
    "set-scheduled-date",
    "set-start-date",
    "add-tags",
    "remove-tags",
    "set-project",
    "set-recurrence",
    "complete-task",
    "move-task"
  ]),
  
  // Operation parameters
  newStatus: z.enum(["incomplete", "completed", "in-progress", "cancelled", "deferred", "scheduled"]).optional(),
  newText: z.string().optional(),
  priority: z.enum(["highest", "high", "medium", "low", "lowest"]).optional(),
  dueDate: z.string().optional(),
  scheduledDate: z.string().optional(),
  startDate: z.string().optional(),
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  recurrence: z.string().optional(),
  
  // Movement options
  targetLineNumber: z.number().int().positive().optional(),
  targetSection: z.string().optional(),
  
  // Search options when no line number provided
  searchInSection: z.string().optional(),
  exactMatch: z.boolean().default(true),
});

export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

/**
 * Task update response structure
 */
export interface UpdateTaskResponse {
  success: boolean;
  operation: string;
  filePath: string;
  lineNumber: number;
  originalTask: string;
  updatedTask: string;
  changes: {
    status?: { from: string; to: string };
    text?: { from: string; to: string };
    priority?: { from?: string; to?: string };
    dueDate?: { from?: string; to?: string };
    scheduledDate?: { from?: string; to?: string };
    startDate?: { from?: string; to?: string };
    tags?: { added: string[]; removed: string[] };
    project?: { from?: string; to?: string };
    recurrence?: { from?: string; to?: string };
  };
  executionTime: string;
}

/**
 * Status character mapping for Obsidian Tasks plugin
 */
const STATUS_CHARS = {
  "incomplete": " ",
  "completed": "x",
  "in-progress": "/",
  "cancelled": "-",
  "deferred": ">",
  "scheduled": "<",
} as const;

/**
 * Priority emoji mapping for Obsidian Tasks plugin
 */
const PRIORITY_EMOJIS = {
  "highest": "🔺",
  "high": "🔴",
  "medium": "🟡",
  "low": "🟢",
  "lowest": "🔻",
} as const;

/**
 * Parse a task line to extract components
 */
function parseTaskLine(line: string): {
  indentLevel: number;
  listMarker: string;
  statusChar: string;
  taskText: string;
  fullMatch: boolean;
} | null {
  const taskMatch = line.match(/^(\s*)([*+-]|\d+\.)\s*\[(.)\]\s*(.+)$/);
  
  if (!taskMatch) {
    return null;
  }
  
  const [, whitespace, listMarker, statusChar, taskText] = taskMatch;
  
  return {
    indentLevel: whitespace.length,
    listMarker,
    statusChar,
    taskText: taskText.trim(),
    fullMatch: true,
  };
}

/**
 * Extract metadata from task text
 */
function extractTaskMetadata(taskText: string): {
  priority?: keyof typeof PRIORITY_EMOJIS;
  dueDate?: string;
  scheduledDate?: string;
  startDate?: string;
  completionDate?: string;
  recurrence?: string;
  tags: string[];
  project?: string;
  description: string;
} {
  const metadata = {
    tags: [] as string[],
  } as any;

  // Extract priority emojis
  for (const [priorityLevel, emoji] of Object.entries(PRIORITY_EMOJIS)) {
    if (taskText.includes(emoji)) {
      metadata.priority = priorityLevel as keyof typeof PRIORITY_EMOJIS;
      break;
    }
  }

  // Extract dates
  const dueDateMatch = taskText.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  if (dueDateMatch) metadata.dueDate = dueDateMatch[1];

  const scheduledDateMatch = taskText.match(/⏳\s*(\d{4}-\d{2}-\d{2})/);
  if (scheduledDateMatch) metadata.scheduledDate = scheduledDateMatch[1];

  const startDateMatch = taskText.match(/🛫\s*(\d{4}-\d{2}-\d{2})/);
  if (startDateMatch) metadata.startDate = startDateMatch[1];

  const completionDateMatch = taskText.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
  if (completionDateMatch) metadata.completionDate = completionDateMatch[1];

  // Extract recurrence
  const recurrenceMatch = taskText.match(/🔁\s*(.+?)(?=\s|$|📅|⏳|🛫|✅|➕|#)/);
  if (recurrenceMatch) metadata.recurrence = recurrenceMatch[1].trim();

  // Extract project
  const projectMatch = taskText.match(/#(project(?:\/[\w-]+)?)/i);
  if (projectMatch) metadata.project = projectMatch[1];

  // Extract tags
  const tagMatches = taskText.match(/#[\w\/\-]+/g);
  if (tagMatches) {
    metadata.tags = tagMatches.map(tag => tag.slice(1));
  }

  // Get clean description
  let description = taskText;
  description = description.replace(/🔺|🔴|🟡|🟢|🔻/g, '');
  description = description.replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/✅\s*\d{4}-\d{2}-\d{2}/g, '');
  description = description.replace(/🔁\s*[^📅⏳🛫✅➕#]+/g, '');
  description = description.replace(/#[\w\/\-]+/g, '');
  metadata.description = description.trim();

  return metadata;
}

/**
 * Format a date string to YYYY-MM-DD format
 */
function formatDate(dateInput: string): string {
  const parsed = chrono.parseDate(dateInput);
  if (!parsed) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      `Invalid date format: ${dateInput}`
    );
  }
  
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Apply updates to task metadata
 */
function applyTaskUpdates(
  input: UpdateTaskInput,
  currentMetadata: ReturnType<typeof extractTaskMetadata>
): { newTaskText: string; changes: UpdateTaskResponse['changes'] } {
  const changes: UpdateTaskResponse['changes'] = {};
  let newDescription = currentMetadata.description;
  let newPriority = currentMetadata.priority;
  let newDueDate = currentMetadata.dueDate;
  let newScheduledDate = currentMetadata.scheduledDate;
  let newStartDate = currentMetadata.startDate;
  let newRecurrence = currentMetadata.recurrence;
  let newProject = currentMetadata.project;
  let newTags = [...currentMetadata.tags];

  // Handle text updates
  if (input.operation === "update-text" && input.newText) {
    changes.text = { from: currentMetadata.description, to: input.newText };
    newDescription = input.newText;
  }

  // Handle priority updates
  if (input.operation === "set-priority" && input.priority) {
    changes.priority = { from: currentMetadata.priority, to: input.priority };
    newPriority = input.priority;
  }

  // Handle date updates
  if (input.operation === "set-due-date" && input.dueDate) {
    const formattedDate = formatDate(input.dueDate);
    changes.dueDate = { from: currentMetadata.dueDate, to: formattedDate };
    newDueDate = formattedDate;
  }

  if (input.operation === "set-scheduled-date" && input.scheduledDate) {
    const formattedDate = formatDate(input.scheduledDate);
    changes.scheduledDate = { from: currentMetadata.scheduledDate, to: formattedDate };
    newScheduledDate = formattedDate;
  }

  if (input.operation === "set-start-date" && input.startDate) {
    const formattedDate = formatDate(input.startDate);
    changes.startDate = { from: currentMetadata.startDate, to: formattedDate };
    newStartDate = formattedDate;
  }

  // Handle tag updates
  if (input.operation === "add-tags" && input.tags) {
    const addedTags = input.tags.filter(tag => !newTags.includes(tag));
    newTags.push(...addedTags);
    changes.tags = { added: addedTags, removed: [] };
  }

  if (input.operation === "remove-tags" && input.tags) {
    const removedTags = input.tags.filter(tag => newTags.includes(tag));
    newTags = newTags.filter(tag => !input.tags!.includes(tag));
    changes.tags = { added: [], removed: removedTags };
  }

  // Handle project updates
  if (input.operation === "set-project" && input.project) {
    changes.project = { from: currentMetadata.project, to: input.project };
    newProject = input.project;
  }

  // Handle recurrence updates
  if (input.operation === "set-recurrence" && input.recurrence) {
    changes.recurrence = { from: currentMetadata.recurrence, to: input.recurrence };
    newRecurrence = input.recurrence;
  }

  // Build new task text
  let newTaskText = newDescription;

  // Handle completion
  if (input.operation === "complete-task") {
    const today = new Date();
    const todayStr = formatDate(today.toISOString());
    // Add completion date
    newTaskText += ` ✅ ${todayStr}`;
  }

  // Add priority emoji
  if (newPriority) {
    newTaskText = `${PRIORITY_EMOJIS[newPriority]} ${newTaskText}`;
  }

  // Add dates
  if (newDueDate) {
    newTaskText += ` 📅 ${newDueDate}`;
  }
  if (newScheduledDate) {
    newTaskText += ` ⏳ ${newScheduledDate}`;
  }
  if (newStartDate) {
    newTaskText += ` 🛫 ${newStartDate}`;
  }

  // Add recurrence
  if (newRecurrence) {
    newTaskText += ` 🔁 ${newRecurrence}`;
  }

  // Add project
  if (newProject) {
    newTaskText += ` #project/${newProject}`;
  }

  // Add tags
  if (newTags.length > 0) {
    const tagText = newTags.map(tag => `#${tag}`).join(" ");
    newTaskText += ` ${tagText}`;
  }

  return { newTaskText, changes };
}

/**
 * Find task line in file content
 */
function findTaskLine(
  content: string,
  input: UpdateTaskInput
): { lineNumber: number; taskLine: string } {
  const lines = content.split('\n');
  
  // If line number is provided, use it
  if (input.lineNumber) {
    const lineIndex = input.lineNumber - 1; // Convert to 0-based
    if (lineIndex >= 0 && lineIndex < lines.length) {
      const line = lines[lineIndex];
      const parsed = parseTaskLine(line);
      if (parsed) {
        return { lineNumber: input.lineNumber, taskLine: line };
      }
    }
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      `No task found at line ${input.lineNumber}`
    );
  }
  
  // Search by task text
  if (input.taskText) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parsed = parseTaskLine(line);
      if (parsed) {
        const matches = input.exactMatch 
          ? parsed.taskText === input.taskText
          : parsed.taskText.includes(input.taskText);
        
        if (matches) {
          return { lineNumber: i + 1, taskLine: line };
        }
      }
    }
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      `No task found matching text: "${input.taskText}"`
    );
  }
  
  throw new McpError(
    BaseErrorCode.VALIDATION_ERROR,
    "Either lineNumber or taskText must be provided to identify the task"
  );
}

/**
 * Core logic for updating tasks
 */
export async function obsidianUpdateTaskLogic(
  input: UpdateTaskInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService
): Promise<UpdateTaskResponse> {
  const startTime = Date.now();
  
  logger.info("Updating task with Obsidian Tasks plugin format", {
    ...context,
    operation: "updateTask",
    params: {
      filePath: input.filePath,
      operation: input.operation,
      lineNumber: input.lineNumber,
      taskText: input.taskText?.substring(0, 50),
    },
  });

  try {
    // Step 1: Get current file content
    const fileContent = await obsidianService.getFileContent(input.filePath, "markdown", context);
    const content = typeof fileContent === "string" ? fileContent : fileContent.content;
    
    // Step 2: Find the task line
    const { lineNumber, taskLine } = findTaskLine(content, input);
    const parsed = parseTaskLine(taskLine);
    
    if (!parsed) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Invalid task format at line ${lineNumber}`
      );
    }
    
    logger.debug(`Found task at line ${lineNumber}: ${taskLine}`, context);
    
    // Step 3: Parse current task metadata
    const currentMetadata = extractTaskMetadata(parsed.taskText);
    
    // Step 4: Apply updates based on operation
    let newStatusChar = parsed.statusChar;
    let newTaskText = parsed.taskText;
    let changes: UpdateTaskResponse['changes'] = {};
    
    switch (input.operation) {
      case "toggle-status":
        const currentStatus = Object.entries(STATUS_CHARS).find(([, char]) => char === parsed.statusChar)?.[0];
        const newStatus = currentStatus === "incomplete" ? "completed" : "incomplete";
        newStatusChar = STATUS_CHARS[newStatus as keyof typeof STATUS_CHARS];
        changes.status = { from: currentStatus || "unknown", to: newStatus };
        break;
        
      case "set-status":
        if (!input.newStatus) throw new McpError(BaseErrorCode.VALIDATION_ERROR, "newStatus required for set-status operation");
        const oldStatus = Object.entries(STATUS_CHARS).find(([, char]) => char === parsed.statusChar)?.[0];
        newStatusChar = STATUS_CHARS[input.newStatus];
        changes.status = { from: oldStatus || "unknown", to: input.newStatus };
        break;
        
      case "complete-task":
        newStatusChar = STATUS_CHARS.completed;
        const oldStatusForComplete = Object.entries(STATUS_CHARS).find(([, char]) => char === parsed.statusChar)?.[0];
        changes.status = { from: oldStatusForComplete || "unknown", to: "completed" };
        // Add completion date
        const today = new Date();
        const todayStr = formatDate(today.toISOString());
        newTaskText += ` ✅ ${todayStr}`;
        changes.startDate = { to: todayStr };
        break;
        
      default:
        // Handle metadata updates
        const updateResult = applyTaskUpdates(input, currentMetadata);
        newTaskText = updateResult.newTaskText;
        changes = updateResult.changes;
        break;
    }
    
    // Step 5: Build the new task line
    const newTaskLine = `${" ".repeat(parsed.indentLevel)}${parsed.listMarker} [${newStatusChar}] ${newTaskText}`;
    
    // Step 6: Update the file content
    const lines = content.split('\n');
    lines[lineNumber - 1] = newTaskLine;
    const updatedContent = lines.join('\n');
    
    await obsidianService.updateFileContent(input.filePath, updatedContent, context);
    
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.info("Task updated successfully", {
      ...context,
      executionTime,
      lineNumber,
      operation: input.operation,
    });

    return {
      success: true,
      operation: input.operation,
      filePath: input.filePath,
      lineNumber,
      originalTask: taskLine,
      updatedTask: newTaskLine,
      changes,
      executionTime,
    };

  } catch (error) {
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.error("Task update failed", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      executionTime,
    });

    if (error instanceof McpError) {
      throw error;
    }

    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      `Task update failed: ${error instanceof Error ? error.message : String(error)}`,
      { executionTime, input },
    );
  }
}