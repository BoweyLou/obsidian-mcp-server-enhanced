/**
 * @fileoverview Logic for analyzing Obsidian note connections and relationships.
 */

import { RequestContext } from "../../../utils/index.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";

export interface GraphAnalysisOperation {
  operation: "get_note_links" | "get_backlinks" | "find_orphaned_notes" | "find_hub_notes" | "trace_connection_path" | "analyze_tag_relationships" | "get_vault_stats";
  filePath?: string;
  targetNote?: string;
  minConnections?: number;
  includeTagLinks?: boolean;
  includeFolderStructure?: boolean;
  maxDepth?: number;
}

export interface NoteConnection {
  source: string;
  target: string;
  type: "wikilink" | "markdown_link" | "tag" | "folder" | "backlink";
  context?: string;
}

export interface NoteInfo {
  path: string;
  name: string;
  outgoingLinks: number;
  incomingLinks: number;
  tags: string[];
  folder: string;
  size: number;
  modified: string;
}

export interface GraphAnalysisResult {
  success: boolean;
  operation: string;
  filePath?: string;
  connections?: NoteConnection[];
  notes?: NoteInfo[];
  path?: string[];
  statistics?: {
    totalNotes: number;
    totalConnections: number;
    averageConnections: number;
    orphanedNotes: number;
    hubNotes: number;
    mostConnectedNote?: string;
    tagDistribution?: Record<string, number>;
  };
  message: string;
}

/**
 * Executes graph analysis operations.
 */
export async function executeGraphAnalysisOperation(
  operation: GraphAnalysisOperation,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<GraphAnalysisResult> {
  const {
    operation: op,
    filePath,
    targetNote,
    minConnections = 5,
    includeTagLinks = true,
    includeFolderStructure = false,
    maxDepth = 3,
  } = operation;

  try {
    switch (op) {
      case "get_note_links":
        if (!filePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "filePath is required for get_note_links operation");
        }
        return await getNoteLinks(filePath, includeTagLinks, obsidianService, context);

      case "get_backlinks":
        if (!filePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "filePath is required for get_backlinks operation");
        }
        return await getBacklinks(filePath, includeTagLinks, obsidianService, context);

      case "find_orphaned_notes":
        return await findOrphanedNotes(includeTagLinks, includeFolderStructure, obsidianService, context);

      case "find_hub_notes":
        return await findHubNotes(minConnections, includeTagLinks, obsidianService, context);

      case "trace_connection_path":
        if (!filePath || !targetNote) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Both filePath and targetNote are required for trace_connection_path operation");
        }
        return await traceConnectionPath(filePath, targetNote, maxDepth, includeTagLinks, obsidianService, context);

      case "analyze_tag_relationships":
        return await analyzeTagRelationships(obsidianService, context);

      case "get_vault_stats":
        return await getVaultStats(includeTagLinks, obsidianService, context);

      default:
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Unknown operation: ${op}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Graph analysis operation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get all outgoing links from a specific note.
 */
async function getNoteLinks(
  filePath: string,
  includeTagLinks: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<GraphAnalysisResult> {
  const fileContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const connections = extractConnections(fileContent, filePath, includeTagLinks);

  return {
    success: true,
    operation: "get_note_links",
    filePath,
    connections: connections.filter(conn => conn.source === filePath),
    message: `Found ${connections.length} outgoing connections from ${filePath}`,
  };
}

/**
 * Get all backlinks to a specific note.
 */
async function getBacklinks(
  filePath: string,
  includeTagLinks: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<GraphAnalysisResult> {
  const allFiles = await obsidianService.listFiles("", context);
  const connections: NoteConnection[] = [];
  const noteName = filePath.replace(/\.md$/, '');

  for (const file of allFiles) {
    if (file.endsWith('.md') && file !== filePath) {
      try {
        const content = await obsidianService.getFileContent(file, "markdown", context) as string;
        const fileConnections = extractConnections(content, file, includeTagLinks);
        
        // Find connections that target the specified file
        fileConnections.forEach(conn => {
          if (conn.target === filePath || conn.target === noteName) {
            connections.push({
              ...conn,
              type: "backlink",
            });
          }
        });
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }
  }

  return {
    success: true,
    operation: "get_backlinks",
    filePath,
    connections,
    message: `Found ${connections.length} backlinks to ${filePath}`,
  };
}

/**
 * Find notes with no connections (orphaned notes).
 */
async function findOrphanedNotes(
  includeTagLinks: boolean,
  includeFolderStructure: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<GraphAnalysisResult> {
  const allFiles = await obsidianService.listFiles("", context);
  const markdownFiles = allFiles.filter(file => file.endsWith('.md'));
  const orphanedNotes: NoteInfo[] = [];

  for (const file of markdownFiles) {
    try {
      const content = await obsidianService.getFileContent(file, "markdown", context) as string;
      const outgoingConnections = extractConnections(content, file, includeTagLinks);
      
      // Check for incoming connections by searching other files
      let hasIncomingConnections = false;
      const noteName = file.replace(/\.md$/, '');
      
      for (const otherFile of markdownFiles) {
        if (otherFile !== file) {
          try {
            const otherContent = await obsidianService.getFileContent(otherFile, "markdown", context) as string;
            if (otherContent.includes(`[[${noteName}]]`) || otherContent.includes(`[[${file}]]`)) {
              hasIncomingConnections = true;
              break;
            }
          } catch (error) {
            continue;
          }
        }
      }

      // Consider folder structure if enabled
      const folderConnections = includeFolderStructure ? getFolderConnections(file, markdownFiles) : 0;

      if (outgoingConnections.length === 0 && !hasIncomingConnections && folderConnections === 0) {
        const tags = extractTags(content);
        orphanedNotes.push({
          path: file,
          name: file.split('/').pop() || file,
          outgoingLinks: 0,
          incomingLinks: 0,
          tags,
          folder: file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : '',
          size: content.length,
          modified: new Date().toISOString(), // Note: Would need file stats from API
        });
      }
    } catch (error) {
      continue;
    }
  }

  return {
    success: true,
    operation: "find_orphaned_notes",
    notes: orphanedNotes,
    message: `Found ${orphanedNotes.length} orphaned notes`,
  };
}

/**
 * Find highly connected hub notes.
 */
async function findHubNotes(
  minConnections: number,
  includeTagLinks: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<GraphAnalysisResult> {
  const allFiles = await obsidianService.listFiles("", context);
  const markdownFiles = allFiles.filter(file => file.endsWith('.md'));
  const hubNotes: NoteInfo[] = [];

  for (const file of markdownFiles) {
    try {
      const content = await obsidianService.getFileContent(file, "markdown", context) as string;
      const outgoingConnections = extractConnections(content, file, includeTagLinks);
      
      // Count incoming connections
      let incomingCount = 0;
      const noteName = file.replace(/\.md$/, '');
      
      for (const otherFile of markdownFiles) {
        if (otherFile !== file) {
          try {
            const otherContent = await obsidianService.getFileContent(otherFile, "markdown", context) as string;
            const otherConnections = extractConnections(otherContent, otherFile, includeTagLinks);
            incomingCount += otherConnections.filter(conn => 
              conn.target === file || conn.target === noteName
            ).length;
          } catch (error) {
            continue;
          }
        }
      }

      const totalConnections = outgoingConnections.length + incomingCount;
      
      if (totalConnections >= minConnections) {
        const tags = extractTags(content);
        hubNotes.push({
          path: file,
          name: file.split('/').pop() || file,
          outgoingLinks: outgoingConnections.length,
          incomingLinks: incomingCount,
          tags,
          folder: file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : '',
          size: content.length,
          modified: new Date().toISOString(),
        });
      }
    } catch (error) {
      continue;
    }
  }

  // Sort by total connections (descending)
  hubNotes.sort((a, b) => (b.outgoingLinks + b.incomingLinks) - (a.outgoingLinks + a.incomingLinks));

  return {
    success: true,
    operation: "find_hub_notes",
    notes: hubNotes,
    message: `Found ${hubNotes.length} hub notes with ${minConnections}+ connections`,
  };
}

/**
 * Trace connection path between two notes.
 */
async function traceConnectionPath(
  sourceFile: string,
  targetFile: string,
  maxDepth: number,
  includeTagLinks: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<GraphAnalysisResult> {
  const allFiles = await obsidianService.listFiles("", context);
  const markdownFiles = allFiles.filter(file => file.endsWith('.md'));
  
  // Build connection graph
  const connectionGraph = new Map<string, string[]>();
  
  for (const file of markdownFiles) {
    try {
      const content = await obsidianService.getFileContent(file, "markdown", context) as string;
      const connections = extractConnections(content, file, includeTagLinks);
      connectionGraph.set(file, connections.map(conn => conn.target));
    } catch (error) {
      connectionGraph.set(file, []);
    }
  }

  // BFS to find shortest path
  const path = findShortestPath(sourceFile, targetFile, connectionGraph, maxDepth);

  return {
    success: true,
    operation: "trace_connection_path",
    filePath: sourceFile,
    path,
    message: path.length > 0 
      ? `Found path from ${sourceFile} to ${targetFile}: ${path.length - 1} hops`
      : `No path found between ${sourceFile} and ${targetFile} within ${maxDepth} hops`,
  };
}

/**
 * Analyze tag relationships and co-occurrences.
 */
async function analyzeTagRelationships(
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<GraphAnalysisResult> {
  const allFiles = await obsidianService.listFiles("", context);
  const markdownFiles = allFiles.filter(file => file.endsWith('.md'));
  const tagCooccurrence = new Map<string, Map<string, number>>();
  const tagDistribution = new Map<string, number>();

  for (const file of markdownFiles) {
    try {
      const content = await obsidianService.getFileContent(file, "markdown", context) as string;
      const tags = extractTags(content);
      
      // Count tag distribution
      tags.forEach(tag => {
        tagDistribution.set(tag, (tagDistribution.get(tag) || 0) + 1);
      });

      // Count tag co-occurrences
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const tag1 = tags[i];
          const tag2 = tags[j];
          
          if (!tagCooccurrence.has(tag1)) {
            tagCooccurrence.set(tag1, new Map());
          }
          if (!tagCooccurrence.has(tag2)) {
            tagCooccurrence.set(tag2, new Map());
          }
          
          const tag1Map = tagCooccurrence.get(tag1)!;
          const tag2Map = tagCooccurrence.get(tag2)!;
          
          tag1Map.set(tag2, (tag1Map.get(tag2) || 0) + 1);
          tag2Map.set(tag1, (tag2Map.get(tag1) || 0) + 1);
        }
      }
    } catch (error) {
      continue;
    }
  }

  return {
    success: true,
    operation: "analyze_tag_relationships",
    statistics: {
      totalNotes: markdownFiles.length,
      totalConnections: 0,
      averageConnections: 0,
      orphanedNotes: 0,
      hubNotes: 0,
      tagDistribution: Object.fromEntries(tagDistribution),
    },
    message: `Analyzed ${tagDistribution.size} unique tags across ${markdownFiles.length} notes`,
  };
}

/**
 * Get overall vault statistics.
 */
async function getVaultStats(
  includeTagLinks: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<GraphAnalysisResult> {
  const allFiles = await obsidianService.listFiles("", context);
  const markdownFiles = allFiles.filter(file => file.endsWith('.md'));
  
  let totalConnections = 0;
  let orphanedCount = 0;
  let maxConnections = 0;
  let mostConnectedNote = '';
  const tagDistribution = new Map<string, number>();

  for (const file of markdownFiles) {
    try {
      const content = await obsidianService.getFileContent(file, "markdown", context) as string;
      const connections = extractConnections(content, file, includeTagLinks);
      const tags = extractTags(content);
      
      totalConnections += connections.length;
      
      if (connections.length === 0) {
        orphanedCount++;
      }
      
      if (connections.length > maxConnections) {
        maxConnections = connections.length;
        mostConnectedNote = file;
      }
      
      tags.forEach(tag => {
        tagDistribution.set(tag, (tagDistribution.get(tag) || 0) + 1);
      });
    } catch (error) {
      continue;
    }
  }

  const averageConnections = markdownFiles.length > 0 ? totalConnections / markdownFiles.length : 0;

  return {
    success: true,
    operation: "get_vault_stats",
    statistics: {
      totalNotes: markdownFiles.length,
      totalConnections,
      averageConnections: Math.round(averageConnections * 100) / 100,
      orphanedNotes: orphanedCount,
      hubNotes: markdownFiles.filter(f => {
        // This is a simplified count - would need full analysis for accuracy
        return false;
      }).length,
      mostConnectedNote,
      tagDistribution: Object.fromEntries(tagDistribution),
    },
    message: `Vault contains ${markdownFiles.length} notes with ${totalConnections} total connections`,
  };
}

/**
 * Extract connections from note content.
 */
function extractConnections(content: string, sourcePath: string, includeTagLinks: boolean): NoteConnection[] {
  const connections: NoteConnection[] = [];

  // Extract wikilinks [[Note Name]]
  const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = wikilinkRegex.exec(content)) !== null) {
    connections.push({
      source: sourcePath,
      target: match[1].includes('|') ? match[1].split('|')[0] : match[1],
      type: "wikilink",
      context: getContextAroundMatch(content, match.index, 50),
    });
  }

  // Extract markdown links [text](link)
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((match = markdownLinkRegex.exec(content)) !== null) {
    const link = match[2];
    if (link.endsWith('.md') || !link.includes('://')) {
      connections.push({
        source: sourcePath,
        target: link.replace(/\.md$/, ''),
        type: "markdown_link",
        context: getContextAroundMatch(content, match.index, 50),
      });
    }
  }

  // Extract tag links if enabled
  if (includeTagLinks) {
    const tags = extractTags(content);
    tags.forEach(tag => {
      connections.push({
        source: sourcePath,
        target: tag,
        type: "tag",
      });
    });
  }

  return connections;
}

/**
 * Extract tags from content.
 */
function extractTags(content: string): string[] {
  const tagRegex = /#[\w-]+/g;
  return Array.from(content.matchAll(tagRegex)).map(match => match[0]);
}

/**
 * Get folder-based connections.
 */
function getFolderConnections(filePath: string, allFiles: string[]): number {
  const folder = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
  return allFiles.filter(file => 
    file !== filePath && 
    file.startsWith(folder + '/') && 
    file.split('/').length === filePath.split('/').length
  ).length;
}

/**
 * Find shortest path between two notes using BFS.
 */
function findShortestPath(
  start: string, 
  target: string, 
  graph: Map<string, string[]>, 
  maxDepth: number
): string[] {
  if (start === target) return [start];
  
  const queue: [string, string[]][] = [[start, [start]]];
  const visited = new Set<string>();
  
  while (queue.length > 0) {
    const [current, path] = queue.shift()!;
    
    if (path.length > maxDepth) continue;
    if (visited.has(current)) continue;
    
    visited.add(current);
    const connections = graph.get(current) || [];
    
    for (const next of connections) {
      if (next === target) {
        return [...path, next];
      }
      
      if (!visited.has(next) && path.length < maxDepth) {
        queue.push([next, [...path, next]]);
      }
    }
  }
  
  return [];
}

/**
 * Get context around a match.
 */
function getContextAroundMatch(content: string, index: number, contextLength: number): string {
  const start = Math.max(0, index - contextLength);
  const end = Math.min(content.length, index + contextLength);
  return content.substring(start, end).trim();
}