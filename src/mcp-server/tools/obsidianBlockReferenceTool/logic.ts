/**
 * @fileoverview Logic for managing Obsidian block references and heading operations.
 */

import { RequestContext } from "../../../utils/index.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";

export interface BlockReferenceOperation {
  operation: "insert_under_heading" | "create_block_reference" | "get_heading_content" | "list_headings" | "get_block_content" | "append_to_heading" | "prepend_to_heading";
  filePath: string;
  heading?: string;
  headingLevel?: number;
  content?: string;
  blockId?: string;
  position?: "start" | "end" | "after_heading" | "before_next_heading";
  createHeading?: boolean;
  includeSubheadings?: boolean;
}

export interface BlockReferenceResult {
  success: boolean;
  operation: string;
  filePath: string;
  heading?: string;
  blockId?: string;
  content?: string;
  headings?: Array<{ level: number; text: string; line: number }>;
  created?: boolean;
  inserted?: boolean;
  message?: string;
}

/**
 * Executes block reference and heading operations.
 */
export async function executeBlockReferenceOperation(
  operation: BlockReferenceOperation,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<BlockReferenceResult> {
  const { 
    operation: op, 
    filePath, 
    heading, 
    headingLevel, 
    content, 
    blockId, 
    position = "end", 
    createHeading = false, 
    includeSubheadings = false 
  } = operation;

  try {
    // Validate operation-specific requirements
    if (["insert_under_heading", "get_heading_content", "append_to_heading", "prepend_to_heading"].includes(op) && !heading) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Heading is required for ${op} operation`);
    }

    if (["insert_under_heading", "append_to_heading", "prepend_to_heading", "create_block_reference"].includes(op) && !content) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Content is required for ${op} operation`);
    }

    if (["get_block_content", "create_block_reference"].includes(op) && !blockId) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Block ID is required for ${op} operation`);
    }

    switch (op) {
      case "list_headings":
        return await listHeadings(filePath, obsidianService, context);

      case "get_heading_content":
        return await getHeadingContent(filePath, heading!, includeSubheadings, obsidianService, context);

      case "get_block_content":
        return await getBlockContent(filePath, blockId!, obsidianService, context);

      case "insert_under_heading":
        return await insertUnderHeading(filePath, heading!, content!, position, createHeading, obsidianService, context, headingLevel);

      case "append_to_heading":
        return await appendToHeading(filePath, heading!, content!, createHeading, obsidianService, context, headingLevel);

      case "prepend_to_heading":
        return await prependToHeading(filePath, heading!, content!, createHeading, obsidianService, context, headingLevel);

      case "create_block_reference":
        return await createBlockReference(filePath, content!, blockId!, obsidianService, context);

      default:
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Unknown operation: ${op}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Block reference operation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * List all headings in a file.
 */
async function listHeadings(
  filePath: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<BlockReferenceResult> {
  const fileContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const lines = fileContent.split('\n');
  const headings: Array<{ level: number; text: string; line: number }> = [];

  lines.forEach((line, index) => {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      headings.push({
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
        line: index + 1,
      });
    }
  });

  return {
    success: true,
    operation: "list_headings",
    filePath,
    headings,
    message: `Found ${headings.length} headings`,
  };
}

/**
 * Get content under a specific heading.
 */
async function getHeadingContent(
  filePath: string,
  heading: string,
  includeSubheadings: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<BlockReferenceResult> {
  const fileContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const lines = fileContent.split('\n');
  
  const headingInfo = findHeading(lines, heading);
  if (!headingInfo) {
    throw new McpError(BaseErrorCode.NOT_FOUND, `Heading "${heading}" not found in file`);
  }

  const content = extractHeadingContent(lines, headingInfo.line, headingInfo.level, includeSubheadings);

  return {
    success: true,
    operation: "get_heading_content",
    filePath,
    heading,
    content,
    message: `Retrieved content under heading "${heading}"`,
  };
}

/**
 * Get content of a specific block reference.
 */
async function getBlockContent(
  filePath: string,
  blockId: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<BlockReferenceResult> {
  const fileContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const lines = fileContent.split('\n');
  
  const blockLine = lines.findIndex(line => line.includes(`^${blockId}`));
  if (blockLine === -1) {
    throw new McpError(BaseErrorCode.NOT_FOUND, `Block reference "^${blockId}" not found in file`);
  }

  // Get the content of the line containing the block reference
  const content = lines[blockLine].replace(/\s*\^[\w-]+\s*$/, '').trim();

  return {
    success: true,
    operation: "get_block_content",
    filePath,
    blockId,
    content,
    message: `Retrieved content for block "^${blockId}"`,
  };
}

/**
 * Insert content under a specific heading.
 */
async function insertUnderHeading(
  filePath: string,
  heading: string,
  content: string,
  position: string,
  createHeading: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
  headingLevel?: number,
): Promise<BlockReferenceResult> {
  const fileContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const lines = fileContent.split('\n');
  
  let headingInfo = findHeading(lines, heading);
  let created = false;

  if (!headingInfo && createHeading) {
    // Create the heading at the end of the file
    const level = headingLevel || 2;
    const headingText = `${'#'.repeat(level)} ${heading}`;
    lines.push('', headingText, '');
    headingInfo = { line: lines.length - 2, level, text: heading };
    created = true;
  } else if (!headingInfo) {
    throw new McpError(BaseErrorCode.NOT_FOUND, `Heading "${heading}" not found. Set createHeading=true to create it.`);
  }

  const insertionPoint = getInsertionPoint(lines, headingInfo!, position);
  lines.splice(insertionPoint, 0, content);

  const newContent = lines.join('\n');
  await obsidianService.updateFileContent(filePath, newContent, context);

  return {
    success: true,
    operation: "insert_under_heading",
    filePath,
    heading,
    created,
    inserted: true,
    message: `Inserted content under heading "${heading}"${created ? " (created heading)" : ""}`,
  };
}

/**
 * Append content to a heading section.
 */
async function appendToHeading(
  filePath: string,
  heading: string,
  content: string,
  createHeading: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
  headingLevel?: number,
): Promise<BlockReferenceResult> {
  return await insertUnderHeading(filePath, heading, content, "before_next_heading", createHeading, obsidianService, context, headingLevel);
}

/**
 * Prepend content to a heading section.
 */
async function prependToHeading(
  filePath: string,
  heading: string,
  content: string,
  createHeading: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
  headingLevel?: number,
): Promise<BlockReferenceResult> {
  return await insertUnderHeading(filePath, heading, content, "after_heading", createHeading, obsidianService, context, headingLevel);
}

/**
 * Create a block reference for specific content.
 */
async function createBlockReference(
  filePath: string,
  content: string,
  blockId: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<BlockReferenceResult> {
  const fileContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const lines = fileContent.split('\n');
  
  // Find if block ID already exists
  const existingBlock = lines.findIndex(line => line.includes(`^${blockId}`));
  if (existingBlock !== -1) {
    throw new McpError(BaseErrorCode.CONFLICT, `Block reference "^${blockId}" already exists in file`);
  }

  // Add the content with block reference
  const contentWithBlock = `${content} ^${blockId}`;
  lines.push('', contentWithBlock);

  const newContent = lines.join('\n');
  await obsidianService.updateFileContent(filePath, newContent, context);

  return {
    success: true,
    operation: "create_block_reference",
    filePath,
    blockId,
    content,
    inserted: true,
    message: `Created block reference "^${blockId}" with content`,
  };
}

/**
 * Helper function to find a heading in lines.
 */
function findHeading(lines: string[], targetHeading: string): { line: number; level: number; text: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[2].trim();
      if (headingText.toLowerCase() === targetHeading.toLowerCase()) {
        return {
          line: i,
          level: headingMatch[1].length,
          text: headingText,
        };
      }
    }
  }
  return null;
}

/**
 * Extract content under a heading.
 */
function extractHeadingContent(lines: string[], headingLine: number, headingLevel: number, includeSubheadings: boolean): string {
  const contentLines: string[] = [];
  
  for (let i = headingLine + 1; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    
    if (headingMatch) {
      const currentLevel = headingMatch[1].length;
      if (currentLevel <= headingLevel) {
        // Found a heading at the same level or higher, stop here
        break;
      }
      if (!includeSubheadings && currentLevel > headingLevel) {
        // Skip subheadings if not including them
        continue;
      }
    }
    
    contentLines.push(line);
  }
  
  return contentLines.join('\n').trim();
}

/**
 * Get the insertion point for content based on position.
 */
function getInsertionPoint(lines: string[], headingInfo: { line: number; level: number }, position: string): number {
  switch (position) {
    case "after_heading":
      return headingInfo.line + 1;
    
    case "before_next_heading":
      // Find the next heading at the same level or higher
      for (let i = headingInfo.line + 1; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch && headingMatch[1].length <= headingInfo.level) {
          return i;
        }
      }
      return lines.length; // Insert at end if no next heading found
    
    case "start":
      return headingInfo.line + 1;
    
    case "end":
    default:
      // Find the end of this heading's section
      for (let i = headingInfo.line + 1; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch && headingMatch[1].length <= headingInfo.level) {
          return i;
        }
      }
      return lines.length; // Insert at end if no next heading found
  }
}