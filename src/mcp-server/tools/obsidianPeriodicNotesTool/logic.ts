/**
 * @fileoverview Logic for managing Obsidian periodic notes operations.
 */

import { RequestContext } from "../../../utils/index.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { Period, NoteJson } from "../../../services/obsidianRestAPI/types.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";

export interface PeriodicNotesOperation {
  operation: "get" | "create" | "append" | "update" | "list_periods" | "exists";
  period?: Period;
  content?: string;
  date?: string;
  format?: "markdown" | "json";
  template?: string;
  createIfNotExists?: boolean;
}

export interface PeriodicNotesResult {
  success: boolean;
  operation: string;
  period?: string;
  date?: string;
  exists?: boolean;
  content?: string | NoteJson;
  created?: boolean;
  appended?: boolean;
  availablePeriods?: string[];
  message?: string;
}

/**
 * Executes periodic notes operations.
 */
export async function executePeriodicNotesOperation(
  operation: PeriodicNotesOperation,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  const { operation: op, period, content, date, format = "markdown", template, createIfNotExists } = operation;

  try {
    switch (op) {
      case "list_periods":
        return {
          success: true,
          operation: op,
          availablePeriods: ["daily", "weekly", "monthly", "quarterly", "yearly"],
          message: "Available periodic note types",
        };

      case "exists":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for exists operation");
        }
        return await checkPeriodicNoteExists(period, obsidianService, context);

      case "get":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for get operation");
        }
        return await getPeriodicNote(period, format, obsidianService, context);

      case "create":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for create operation");
        }
        return await createPeriodicNote(period, content, template, obsidianService, context);

      case "update":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for update operation");
        }
        if (!content) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Content is required for update operation");
        }
        return await updatePeriodicNote(period, content, obsidianService, context);

      case "append":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for append operation");
        }
        if (!content) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Content is required for append operation");
        }
        return await appendToPeriodicNote(period, content, createIfNotExists || false, obsidianService, context);

      default:
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Unknown operation: ${op}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Periodic notes operation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if a periodic note exists.
 */
async function checkPeriodicNoteExists(
  period: Period,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  try {
    await obsidianService.getPeriodicNote(period, "markdown", context);
    return {
      success: true,
      operation: "exists",
      period,
      exists: true,
      message: `${period} note exists`,
    };
  } catch (error) {
    return {
      success: true,
      operation: "exists",
      period,
      exists: false,
      message: `${period} note does not exist`,
    };
  }
}

/**
 * Get a periodic note.
 */
async function getPeriodicNote(
  period: Period,
  format: "markdown" | "json",
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  try {
    const content = await obsidianService.getPeriodicNote(period, format, context);
    return {
      success: true,
      operation: "get",
      period,
      content,
      message: `Retrieved ${period} note`,
    };
  } catch (error) {
    throw new McpError(BaseErrorCode.NOT_FOUND, `${period} note not found. Use create operation to create it first.`);
  }
}

/**
 * Create a new periodic note.
 */
async function createPeriodicNote(
  period: Period,
  content: string | undefined,
  template: string | undefined,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  let noteContent = content || "";

  // If template is provided, use it as the base content
  if (template) {
    noteContent = await processTemplate(template, period, obsidianService, context);
    // If additional content is provided, append it
    if (content) {
      noteContent += "\n\n" + content;
    }
  }

  // If no content or template, create a basic structure
  if (!noteContent) {
    noteContent = await createDefaultPeriodicContent(period);
  }

  await obsidianService.updatePeriodicNote(period, noteContent, context);

  return {
    success: true,
    operation: "create",
    period,
    created: true,
    message: `Created ${period} note${template ? " from template" : ""}`,
  };
}

/**
 * Update a periodic note (overwrites existing content).
 */
async function updatePeriodicNote(
  period: Period,
  content: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  await obsidianService.updatePeriodicNote(period, content, context);

  return {
    success: true,
    operation: "update",
    period,
    message: `Updated ${period} note`,
  };
}

/**
 * Append content to a periodic note.
 */
async function appendToPeriodicNote(
  period: Period,
  content: string,
  createIfNotExists: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  try {
    // Try to get existing content
    const existingContent = await obsidianService.getPeriodicNote(period, "markdown", context) as string;
    const newContent = existingContent + "\n\n" + content;
    await obsidianService.updatePeriodicNote(period, newContent, context);

    return {
      success: true,
      operation: "append",
      period,
      appended: true,
      message: `Appended content to ${period} note`,
    };
  } catch (error) {
    if (createIfNotExists) {
      // Create new note with the content
      await obsidianService.updatePeriodicNote(period, content, context);
      return {
        success: true,
        operation: "append",
        period,
        created: true,
        appended: true,
        message: `Created ${period} note and added content`,
      };
    }
    throw new McpError(BaseErrorCode.NOT_FOUND, `${period} note not found. Set createIfNotExists=true to create it.`);
  }
}

/**
 * Process a template for periodic notes.
 */
async function processTemplate(
  template: string,
  period: Period,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<string> {
  // If template looks like a file path, try to read it
  if (template.includes("/") || template.endsWith(".md")) {
    try {
      const templateContent = await obsidianService.getFileContent(template, "markdown", context) as string;
      return processTemplateVariables(templateContent, period);
    } catch (error) {
      // If file doesn't exist, treat template as literal content
      return processTemplateVariables(template, period);
    }
  }

  // Otherwise, treat as literal template content
  return processTemplateVariables(template, period);
}

/**
 * Process template variables in content.
 */
function processTemplateVariables(content: string, period: Period): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  const monthName = now.toLocaleDateString('en-US', { month: 'long' });
  const year = now.getFullYear();

  return content
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{time\}\}/g, timeStr)
    .replace(/\{\{day\}\}/g, dayName)
    .replace(/\{\{month\}\}/g, monthName)
    .replace(/\{\{year\}\}/g, year.toString())
    .replace(/\{\{period\}\}/g, period)
    .replace(/\{\{title\}\}/g, `${period.charAt(0).toUpperCase() + period.slice(1)} Note - ${dateStr}`);
}

/**
 * Create default content for periodic notes.
 */
async function createDefaultPeriodicContent(period: Period): Promise<string> {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  
  switch (period) {
    case "daily":
      return `# Daily Note - ${dateStr} (${dayName})

## Today's Goals
- 

## Notes


## Reflections


## Tomorrow's Priorities
- `;

    case "weekly":
      const weekStart = getWeekStart(now);
      const weekEnd = getWeekEnd(now);
      return `# Weekly Note - Week of ${weekStart.toISOString().split('T')[0]}

## Week Overview
${weekStart.toISOString().split('T')[0]} to ${weekEnd.toISOString().split('T')[0]}

## This Week's Goals
- 

## Achievements


## Lessons Learned


## Next Week's Focus
- `;

    case "monthly":
      const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      return `# Monthly Note - ${monthName}

## Month Overview

## Goals for This Month
- 

## Key Projects


## Monthly Review


## Next Month's Priorities
- `;

    case "quarterly":
      const quarter = Math.floor(now.getMonth() / 3) + 1;
      return `# Quarterly Note - Q${quarter} ${now.getFullYear()}

## Quarter Overview

## Quarterly Goals
- 

## Major Projects


## Quarterly Review


## Next Quarter's Focus
- `;

    case "yearly":
      return `# Yearly Note - ${now.getFullYear()}

## Year Overview

## Annual Goals
- 

## Major Achievements


## Year in Review


## Next Year's Vision
- `;

    default:
      return `# ${(period as string).charAt(0).toUpperCase() + (period as string).slice(1)} Note - ${dateStr}

## Notes

`;
  }
}

/**
 * Get the start of the week (Monday).
 */
function getWeekStart(date: Date): Date {
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  return new Date(date.setDate(diff));
}

/**
 * Get the end of the week (Sunday).
 */
function getWeekEnd(date: Date): Date {
  const weekStart = getWeekStart(new Date(date));
  return new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
}