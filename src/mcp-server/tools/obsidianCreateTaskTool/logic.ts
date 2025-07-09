/**
 * @fileoverview Core logic for the Obsidian Create Task tool.
 * Provides functionality to create tasks in Obsidian with full Tasks plugin metadata support.
 * @module obsidianCreateTaskTool/logic
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
 * Task creation input schema with full Obsidian Tasks plugin support
 */
export const CreateTaskInputSchema = z.object({
  text: z.string().min(1, "Task text cannot be empty"),
  
  // Target location
  filePath: z.string().optional(),
  useActiveFile: z.boolean().default(false),
  usePeriodicNote: z.enum(["daily", "weekly", "monthly"]).optional(),
  section: z.string().optional(), // Heading to place task under
  
  // Task metadata
  status: z.enum(["incomplete", "completed", "in-progress", "cancelled", "deferred", "scheduled"]).default("incomplete"),
  priority: z.enum(["highest", "high", "medium", "low", "lowest"]).optional(),
  
  // Dates
  dueDate: z.string().optional(),
  scheduledDate: z.string().optional(),
  startDate: z.string().optional(),
  
  // Other metadata
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  recurrence: z.string().optional(),
  
  // Positioning
  insertAt: z.enum(["top", "bottom", "after-heading"]).default("bottom"),
  indentLevel: z.number().int().min(0).max(6).default(0),
  listStyle: z.enum(["-", "*", "1."]).default("-"),
});

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

/**
 * Task creation response structure
 */
export interface CreateTaskResponse {
  success: boolean;
  taskText: string;
  filePath: string;
  lineNumber: number;
  formattedTask: string;
  metadata: {
    status: string;
    priority?: string;
    dueDate?: string;
    scheduledDate?: string;
    startDate?: string;
    tags: string[];
    project?: string;
    recurrence?: string;
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
};

/**
 * Priority emoji mapping for Obsidian Tasks plugin
 */
const PRIORITY_EMOJIS = {
  "highest": "🔺",
  "high": "🔴",
  "medium": "🟡",
  "low": "🟢",
  "lowest": "🔻",
};

/**
 * Format a date string to YYYY-MM-DD format
 */
function formatDate(dateInput: string): string {
  const parsed = chrono.parseDate(dateInput);
  if (!parsed) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      `Invalid date format: ${dateInput}. Please use formats like "2024-06-19", "tomorrow", "next Friday", etc.`
    );
  }
  
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Build the formatted task text with all metadata
 */
function buildTaskText(input: CreateTaskInput): string {
  let taskText = input.text;
  
  // Add priority emoji if specified
  if (input.priority) {
    const priorityEmoji = PRIORITY_EMOJIS[input.priority];
    taskText = `${priorityEmoji} ${taskText}`;
  }
  
  // Add dates
  if (input.dueDate) {
    const formattedDue = formatDate(input.dueDate);
    taskText += ` 📅 ${formattedDue}`;
  }
  
  if (input.scheduledDate) {
    const formattedScheduled = formatDate(input.scheduledDate);
    taskText += ` ⏳ ${formattedScheduled}`;
  }
  
  if (input.startDate) {
    const formattedStart = formatDate(input.startDate);
    taskText += ` 🛫 ${formattedStart}`;
  }
  
  // Add recurrence
  if (input.recurrence) {
    taskText += ` 🔁 ${input.recurrence}`;
  }
  
  // Add project tag
  if (input.project) {
    taskText += ` #project/${input.project}`;
  }
  
  // Add tags
  if (input.tags && input.tags.length > 0) {
    const tagText = input.tags.map(tag => `#${tag}`).join(" ");
    taskText += ` ${tagText}`;
  }
  
  return taskText;
}

/**
 * Build the complete task line with checkbox and indentation
 */
function buildTaskLine(input: CreateTaskInput, taskText: string): string {
  const statusChar = STATUS_CHARS[input.status];
  const indent = "  ".repeat(input.indentLevel); // 2 spaces per indent level
  const listMarker = input.listStyle === "1." ? "1." : input.listStyle;
  
  return `${indent}${listMarker} [${statusChar}] ${taskText}`;
}

/**
 * Find the target file path for task creation
 */
async function resolveTargetFile(
  input: CreateTaskInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService
): Promise<string> {
  // If using active file
  if (input.useActiveFile) {
    try {
      const activeFile = await obsidianService.getActiveFile("json", context);
      if (typeof activeFile === "object" && activeFile.path) {
        return activeFile.path;
      }
    } catch (error) {
      logger.warning("Failed to get active file, falling back to explicit path", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  
  // If using periodic note
  if (input.usePeriodicNote) {
    try {
      const periodicNote = await obsidianService.getPeriodicNote(input.usePeriodicNote, "json", context);
      if (typeof periodicNote === "object" && periodicNote.path) {
        return periodicNote.path;
      } else if (typeof periodicNote === "string") {
        // If we get content but no path, we need to construct a default path
        const today = new Date();
        const dateStr = today.getFullYear() + '-' + 
                       String(today.getMonth() + 1).padStart(2, '0') + '-' + 
                       String(today.getDate()).padStart(2, '0');
        
        switch (input.usePeriodicNote) {
          case "daily":
            return `Daily Notes/${dateStr}.md`;
          case "weekly":
            return `Weekly Notes/Week of ${dateStr}.md`;
          case "monthly":
            return `Monthly Notes/${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}.md`;
          default:
            return `${input.usePeriodicNote} Notes/${dateStr}.md`;
        }
      }
    } catch (error) {
      logger.warning("Failed to get periodic note, falling back to explicit path", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  
  // Use explicit file path
  if (input.filePath) {
    return input.filePath;
  }
  
  throw new McpError(
    BaseErrorCode.VALIDATION_ERROR,
    "No target file specified. Please provide filePath, set useActiveFile=true, or specify usePeriodicNote."
  );
}

/**
 * Find the insertion point in the file content
 */
function findInsertionPoint(
  content: string,
  input: CreateTaskInput
): { lineNumber: number; content: string } {
  const lines = content.split('\n');
  
  // If section is specified, find the heading
  if (input.section) {
    const headingPattern = new RegExp(`^#+\\s+${input.section}`, 'i');
    let headingIndex = -1;
    
    for (let i = 0; i < lines.length; i++) {
      if (headingPattern.test(lines[i])) {
        headingIndex = i;
        break;
      }
    }
    
    if (headingIndex >= 0) {
      // Find the end of this section (next heading at same or higher level)
      const headingLevel = (lines[headingIndex].match(/^#+/) || [''])[0].length;
      let sectionEnd = lines.length;
      
      for (let i = headingIndex + 1; i < lines.length; i++) {
        const lineHeadingMatch = lines[i].match(/^#+/);
        if (lineHeadingMatch && lineHeadingMatch[0].length <= headingLevel) {
          sectionEnd = i;
          break;
        }
      }
      
      if (input.insertAt === "after-heading") {
        return { lineNumber: headingIndex + 1, content: lines.join('\n') };
      } else {
        // Insert at bottom of section
        return { lineNumber: sectionEnd, content: lines.join('\n') };
      }
    }
  }
  
  // Default insertion points
  switch (input.insertAt) {
    case "top":
      return { lineNumber: 0, content: lines.join('\n') };
    case "bottom":
    default:
      return { lineNumber: lines.length, content: lines.join('\n') };
  }
}

/**
 * Core logic for creating tasks
 */
export async function obsidianCreateTaskLogic(
  input: CreateTaskInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService
): Promise<CreateTaskResponse> {
  const startTime = Date.now();
  
  logger.info("Creating new task with Obsidian Tasks plugin format", {
    ...context,
    operation: "createTask",
    params: {
      text: input.text.substring(0, 50),
      status: input.status,
      priority: input.priority,
      hasDate: !!(input.dueDate || input.scheduledDate || input.startDate),
      tagCount: input.tags?.length || 0,
      useActiveFile: input.useActiveFile,
      usePeriodicNote: input.usePeriodicNote,
    },
  });

  try {
    // Step 1: Resolve target file
    const targetFile = await resolveTargetFile(input, context, obsidianService);
    
    logger.debug(`Resolved target file: ${targetFile}`, context);
    
    // Step 2: Build task text with all metadata
    const taskText = buildTaskText(input);
    const taskLine = buildTaskLine(input, taskText);
    
    logger.debug(`Built task line: ${taskLine}`, context);
    
    // Step 3: Get current file content
    let currentContent = "";
    try {
      const fileContent = await obsidianService.getFileContent(targetFile, "markdown", context);
      currentContent = typeof fileContent === "string" ? fileContent : fileContent.content;
    } catch (error) {
      // File might not exist, which is fine - we'll create it
      logger.info(`File ${targetFile} doesn't exist, will create new file`, context);
      currentContent = "";
    }
    
    // Step 4: Find insertion point
    const { lineNumber, content } = findInsertionPoint(currentContent, input);
    
    // Step 5: Insert the task
    const lines = content.split('\n');
    lines.splice(lineNumber, 0, taskLine);
    const updatedContent = lines.join('\n');
    
    // Step 6: Write the updated content
    await obsidianService.updateFileContent(
      targetFile,
      updatedContent,
      context
    );
    
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.info("Task created successfully", {
      ...context,
      executionTime,
      targetFile,
      lineNumber: lineNumber + 1, // 1-based line numbers
      taskLength: taskLine.length,
    });

    // Step 7: Build response metadata
    const metadata = {
      status: input.status,
      priority: input.priority,
      dueDate: input.dueDate ? formatDate(input.dueDate) : undefined,
      scheduledDate: input.scheduledDate ? formatDate(input.scheduledDate) : undefined,
      startDate: input.startDate ? formatDate(input.startDate) : undefined,
      tags: input.tags || [],
      project: input.project,
      recurrence: input.recurrence,
    };

    return {
      success: true,
      taskText: input.text,
      filePath: targetFile,
      lineNumber: lineNumber + 1, // 1-based line numbers
      formattedTask: taskLine,
      metadata,
      executionTime,
    };

  } catch (error) {
    const executionTime = `${Date.now() - startTime}ms`;
    
    logger.error("Task creation failed", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      executionTime,
    });

    if (error instanceof McpError) {
      throw error;
    }

    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      `Task creation failed: ${error instanceof Error ? error.message : String(error)}`,
      { executionTime, input: { ...input, text: input.text.substring(0, 50) } },
    );
  }
}