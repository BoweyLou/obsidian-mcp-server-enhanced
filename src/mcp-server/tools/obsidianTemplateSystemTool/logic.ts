/**
 * @fileoverview Logic for managing Obsidian templates and template-based file creation.
 */

import { RequestContext } from "../../../utils/index.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";

export interface TemplateSystemOperation {
  operation: "list_templates" | "get_template" | "create_from_template" | "preview_template" | "validate_template" | "apply_template_variables";
  templatePath?: string;
  targetPath?: string;
  templateFolder?: string;
  variables?: Record<string, string>;
  autoGenerateVariables?: boolean;
  createFolders?: boolean;
  overwriteExisting?: boolean;
}

export interface TemplateInfo {
  path: string;
  name: string;
  size: number;
  variables: string[];
  previewContent?: string;
}

export interface TemplateSystemResult {
  success: boolean;
  operation: string;
  templatePath?: string;
  targetPath?: string;
  templates?: TemplateInfo[];
  content?: string;
  variables?: string[];
  validationErrors?: string[];
  created?: boolean;
  message: string;
}

/**
 * Executes template system operations.
 */
export async function executeTemplateSystemOperation(
  operation: TemplateSystemOperation,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<TemplateSystemResult> {
  const {
    operation: op,
    templatePath,
    targetPath,
    templateFolder = "Templates",
    variables = {},
    autoGenerateVariables = true,
    createFolders = true,
    overwriteExisting = false,
  } = operation;

  try {
    switch (op) {
      case "list_templates":
        return await listTemplates(templateFolder, obsidianService, context);

      case "get_template":
        if (!templatePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "templatePath is required for get_template operation");
        }
        return await getTemplate(templatePath, obsidianService, context);

      case "create_from_template":
        if (!templatePath || !targetPath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Both templatePath and targetPath are required for create_from_template operation");
        }
        return await createFromTemplate(
          templatePath,
          targetPath,
          variables,
          autoGenerateVariables,
          createFolders,
          overwriteExisting,
          obsidianService,
          context
        );

      case "preview_template":
        if (!templatePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "templatePath is required for preview_template operation");
        }
        return await previewTemplate(templatePath, variables, autoGenerateVariables, obsidianService, context);

      case "validate_template":
        if (!templatePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "templatePath is required for validate_template operation");
        }
        return await validateTemplate(templatePath, obsidianService, context);

      case "apply_template_variables":
        if (!templatePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "templatePath is required for apply_template_variables operation");
        }
        return await applyTemplateVariables(templatePath, variables, autoGenerateVariables, obsidianService, context);

      default:
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Unknown operation: ${op}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Template system operation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * List all available templates in the specified folder.
 */
async function listTemplates(
  templateFolder: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<TemplateSystemResult> {
  try {
    const allFiles = await obsidianService.listFiles("", context);
    const templateFiles = allFiles.filter(file => 
      file.startsWith(templateFolder + "/") && 
      file.endsWith('.md')
    );

    const templates: TemplateInfo[] = [];

    for (const file of templateFiles) {
      try {
        const content = await obsidianService.getFileContent(file, "markdown", context) as string;
        const variables = extractTemplateVariables(content);
        
        templates.push({
          path: file,
          name: file.split('/').pop()?.replace('.md', '') || file,
          size: content.length,
          variables,
          previewContent: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
        });
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }

    return {
      success: true,
      operation: "list_templates",
      templates,
      message: `Found ${templates.length} templates in ${templateFolder} folder`,
    };
  } catch (error) {
    throw new McpError(BaseErrorCode.NOT_FOUND, `Template folder '${templateFolder}' not found or inaccessible`);
  }
}

/**
 * Get the content of a specific template.
 */
async function getTemplate(
  templatePath: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<TemplateSystemResult> {
  const content = await obsidianService.getFileContent(templatePath, "markdown", context) as string;
  const variables = extractTemplateVariables(content);

  return {
    success: true,
    operation: "get_template",
    templatePath,
    content,
    variables,
    message: `Retrieved template from ${templatePath} with ${variables.length} variables`,
  };
}

/**
 * Create a new file from a template.
 */
async function createFromTemplate(
  templatePath: string,
  targetPath: string,
  variables: Record<string, string>,
  autoGenerateVariables: boolean,
  createFolders: boolean,
  overwriteExisting: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<TemplateSystemResult> {
  // Check if target file already exists
  if (!overwriteExisting) {
    try {
      await obsidianService.getFileContent(targetPath, "markdown", context);
      throw new McpError(BaseErrorCode.CONFLICT, `File ${targetPath} already exists. Set overwriteExisting=true to overwrite.`);
    } catch (error) {
      // File doesn't exist, which is what we want
      if (!(error instanceof McpError) || error.code !== BaseErrorCode.NOT_FOUND) {
        throw error;
      }
    }
  }

  // Get template content
  const templateContent = await obsidianService.getFileContent(templatePath, "markdown", context) as string;

  // Apply variables
  const processedContent = await processTemplateContent(
    templateContent,
    variables,
    autoGenerateVariables,
    targetPath
  );

  // Create parent folders if needed
  if (createFolders && targetPath.includes('/')) {
    const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
    await ensureFolderExists(parentPath, obsidianService, context);
  }

  // Create the file
  await obsidianService.updateFileContent(targetPath, processedContent, context);

  return {
    success: true,
    operation: "create_from_template",
    templatePath,
    targetPath,
    created: true,
    message: `Created ${targetPath} from template ${templatePath}`,
  };
}

/**
 * Preview what a template would look like with variables applied.
 */
async function previewTemplate(
  templatePath: string,
  variables: Record<string, string>,
  autoGenerateVariables: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<TemplateSystemResult> {
  const templateContent = await obsidianService.getFileContent(templatePath, "markdown", context) as string;
  const processedContent = await processTemplateContent(
    templateContent,
    variables,
    autoGenerateVariables,
    "preview.md"
  );

  return {
    success: true,
    operation: "preview_template",
    templatePath,
    content: processedContent,
    message: `Generated preview for template ${templatePath}`,
  };
}

/**
 * Validate a template for syntax errors and missing variables.
 */
async function validateTemplate(
  templatePath: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<TemplateSystemResult> {
  const content = await obsidianService.getFileContent(templatePath, "markdown", context) as string;
  const variables = extractTemplateVariables(content);
  const validationErrors: string[] = [];

  // Check for malformed variable syntax
  const malformedVariables = content.match(/\{\{[^}]*\}\}/g) || [];
  malformedVariables.forEach(variable => {
    if (!variable.match(/^\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}$/)) {
      validationErrors.push(`Malformed variable syntax: ${variable}`);
    }
  });

  // Check for nested variables
  const nestedVariables = content.match(/\{\{[^}]*\{\{[^}]*\}\}[^}]*\}\}/g) || [];
  if (nestedVariables.length > 0) {
    validationErrors.push("Nested variables are not supported");
  }

  return {
    success: validationErrors.length === 0,
    operation: "validate_template",
    templatePath,
    variables,
    validationErrors,
    message: validationErrors.length === 0 
      ? `Template ${templatePath} is valid with ${variables.length} variables`
      : `Template ${templatePath} has ${validationErrors.length} validation errors`,
  };
}

/**
 * Apply variables to template content without creating a file.
 */
async function applyTemplateVariables(
  templatePath: string,
  variables: Record<string, string>,
  autoGenerateVariables: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<TemplateSystemResult> {
  const templateContent = await obsidianService.getFileContent(templatePath, "markdown", context) as string;
  const processedContent = await processTemplateContent(
    templateContent,
    variables,
    autoGenerateVariables,
    "output.md"
  );

  return {
    success: true,
    operation: "apply_template_variables",
    templatePath,
    content: processedContent,
    message: `Applied variables to template ${templatePath}`,
  };
}

/**
 * Extract template variables from content.
 */
function extractTemplateVariables(content: string): string[] {
  const variableRegex = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
  const variables = new Set<string>();
  let match;

  while ((match = variableRegex.exec(content)) !== null) {
    variables.add(match[1]);
  }

  return Array.from(variables);
}

/**
 * Process template content by applying variables.
 */
async function processTemplateContent(
  content: string,
  userVariables: Record<string, string>,
  autoGenerateVariables: boolean,
  targetPath: string
): Promise<string> {
  let processedContent = content;

  // Auto-generate common variables if enabled
  if (autoGenerateVariables) {
    const now = new Date();
    const autoVars = {
      date: now.toISOString().split('T')[0],
      time: now.toTimeString().split(' ')[0],
      datetime: now.toISOString(),
      year: now.getFullYear().toString(),
      month: (now.getMonth() + 1).toString().padStart(2, '0'),
      day: now.getDate().toString().padStart(2, '0'),
      filename: targetPath.split('/').pop()?.replace('.md', '') || 'untitled',
      title: targetPath.split('/').pop()?.replace('.md', '').replace(/[-_]/g, ' ') || 'Untitled',
      timestamp: Date.now().toString(),
    };

    // Apply auto-generated variables (user variables take precedence)
    Object.entries(autoVars).forEach(([key, value]) => {
      if (!userVariables[key]) {
        processedContent = processedContent.replace(
          new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
          value
        );
      }
    });
  }

  // Apply user-provided variables
  Object.entries(userVariables).forEach(([key, value]) => {
    processedContent = processedContent.replace(
      new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
      value
    );
  });

  return processedContent;
}

/**
 * Ensure a folder exists by creating it if necessary.
 */
async function ensureFolderExists(
  folderPath: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<void> {
  const pathParts = folderPath.split('/');
  let currentPath = '';

  for (const part of pathParts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    
    try {
      await obsidianService.listFiles(currentPath, context);
    } catch (error) {
      // Folder doesn't exist, try to create it
      // Note: Obsidian REST API doesn't have direct folder creation
      // We'll create a temporary file and then delete it to ensure the folder exists
      try {
        const tempFile = `${currentPath}/.temp_folder_creation`;
        await obsidianService.updateFileContent(tempFile, "temp", context);
        
        // Try to delete the temp file (might fail if API doesn't support deletion)
        try {
          await obsidianService.deleteFile(tempFile, context);
        } catch (deleteError) {
          // Ignore deletion errors
        }
      } catch (createError) {
        throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Failed to create folder ${currentPath}`);
      }
    }
  }
}