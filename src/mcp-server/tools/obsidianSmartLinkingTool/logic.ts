/**
 * @fileoverview Logic for intelligent link suggestions and smart linking in Obsidian.
 */

import { RequestContext } from "../../../utils/index.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";

export interface SmartLinkingOperation {
  operation: "suggest_links_for_content" | "find_link_opportunities" | "analyze_linkable_concepts" | "suggest_backlinks" | "recommend_tags" | "find_broken_links" | "get_link_suggestions";
  filePath?: string;
  content?: string;
  maxSuggestions?: number;
  similarityThreshold?: number;
  includeExistingLinks?: boolean;
  contextWindow?: number;
  excludeFolders?: string[];
  includeTagSuggestions?: boolean;
}

export interface LinkSuggestion {
  targetNote: string;
  suggestionType: "content_similarity" | "keyword_match" | "semantic_relationship" | "tag_similarity" | "backlink_opportunity";
  confidence: number;
  reason: string;
  context?: string;
  suggestedText?: string;
  position?: {
    start: number;
    end: number;
  };
}

export interface ConceptAnalysis {
  concept: string;
  frequency: number;
  relatedNotes: string[];
  suggestedTags: string[];
  importance: number;
}

export interface SmartLinkingResult {
  success: boolean;
  operation: string;
  filePath?: string;
  suggestions?: LinkSuggestion[];
  concepts?: ConceptAnalysis[];
  brokenLinks?: string[];
  tags?: string[];
  statistics?: {
    totalSuggestions: number;
    highConfidenceSuggestions: number;
    conceptsAnalyzed: number;
    existingLinks: number;
  };
  message: string;
}

/**
 * Executes smart linking operations.
 */
export async function executeSmartLinkingOperation(
  operation: SmartLinkingOperation,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<SmartLinkingResult> {
  const {
    operation: op,
    filePath,
    content,
    maxSuggestions = 10,
    similarityThreshold = 0.3,
    includeExistingLinks = false,
    contextWindow = 150,
    excludeFolders = [],
    includeTagSuggestions = true,
  } = operation;

  try {
    switch (op) {
      case "suggest_links_for_content":
        return await suggestLinksForContent(
          filePath,
          content,
          maxSuggestions,
          similarityThreshold,
          includeExistingLinks,
          excludeFolders,
          obsidianService,
          context
        );

      case "find_link_opportunities":
        if (!filePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "filePath is required for find_link_opportunities operation");
        }
        return await findLinkOpportunities(
          filePath,
          maxSuggestions,
          contextWindow,
          excludeFolders,
          obsidianService,
          context
        );

      case "analyze_linkable_concepts":
        return await analyzeLinkableConcepts(
          filePath,
          content,
          maxSuggestions,
          includeTagSuggestions,
          obsidianService,
          context
        );

      case "suggest_backlinks":
        if (!filePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "filePath is required for suggest_backlinks operation");
        }
        return await suggestBacklinks(
          filePath,
          maxSuggestions,
          similarityThreshold,
          excludeFolders,
          obsidianService,
          context
        );

      case "recommend_tags":
        return await recommendTags(
          filePath,
          content,
          maxSuggestions,
          obsidianService,
          context
        );

      case "find_broken_links":
        if (!filePath) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "filePath is required for find_broken_links operation");
        }
        return await findBrokenLinks(filePath, obsidianService, context);

      case "get_link_suggestions":
        return await getLinkSuggestions(
          filePath,
          content,
          maxSuggestions,
          similarityThreshold,
          includeExistingLinks,
          excludeFolders,
          obsidianService,
          context
        );

      default:
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Unknown operation: ${op}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Smart linking operation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Suggest links for given content based on similarity and relevance.
 */
async function suggestLinksForContent(
  filePath: string | undefined,
  content: string | undefined,
  maxSuggestions: number,
  similarityThreshold: number,
  includeExistingLinks: boolean,
  excludeFolders: string[],
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<SmartLinkingResult> {
  let targetContent: string;

  if (content) {
    targetContent = content;
  } else if (filePath) {
    targetContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  } else {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Either filePath or content must be provided");
  }

  const allFiles = await obsidianService.listFiles("", context);
  const markdownFiles = allFiles.filter(file => 
    file.endsWith('.md') && 
    file !== filePath &&
    !excludeFolders.some(folder => file.startsWith(folder + '/'))
  );

  const suggestions: LinkSuggestion[] = [];
  const existingLinks = extractExistingLinks(targetContent);
  const targetKeywords = extractKeywords(targetContent);

  for (const file of markdownFiles.slice(0, 100)) { // Limit processing for performance
    try {
      const fileContent = await obsidianService.getFileContent(file, "markdown", context) as string;
      const fileName = file.replace(/\.md$/, '');
      
      // Skip if already linked and not including existing links
      if (!includeExistingLinks && existingLinks.includes(fileName)) {
        continue;
      }

      const similarity = calculateContentSimilarity(targetContent, fileContent, targetKeywords);
      
      if (similarity >= similarityThreshold) {
        suggestions.push({
          targetNote: file,
          suggestionType: "content_similarity",
          confidence: similarity,
          reason: `Content similarity score: ${Math.round(similarity * 100)}%`,
          context: extractRelevantContext(fileContent, targetKeywords, 100),
        });
      }
    } catch (error) {
      continue;
    }
  }

  // Sort by confidence and limit results
  suggestions.sort((a, b) => b.confidence - a.confidence);
  const limitedSuggestions = suggestions.slice(0, maxSuggestions);

  return {
    success: true,
    operation: "suggest_links_for_content",
    filePath,
    suggestions: limitedSuggestions,
    statistics: {
      totalSuggestions: suggestions.length,
      highConfidenceSuggestions: suggestions.filter(s => s.confidence > 0.7).length,
      conceptsAnalyzed: 0,
      existingLinks: existingLinks.length,
    },
    message: `Found ${limitedSuggestions.length} link suggestions with similarity >= ${similarityThreshold}`,
  };
}

/**
 * Find opportunities to add links within existing text.
 */
async function findLinkOpportunities(
  filePath: string,
  maxSuggestions: number,
  contextWindow: number,
  excludeFolders: string[],
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<SmartLinkingResult> {
  const fileContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const allFiles = await obsidianService.listFiles("", context);
  const markdownFiles = allFiles.filter(file => 
    file.endsWith('.md') && 
    file !== filePath &&
    !excludeFolders.some(folder => file.startsWith(folder + '/'))
  );

  const suggestions: LinkSuggestion[] = [];
  const existingLinks = extractExistingLinks(fileContent);

  for (const file of markdownFiles) {
    const fileName = file.replace(/\.md$/, '');
    const fileBaseName = fileName.split('/').pop() || fileName;
    
    // Skip if already linked
    if (existingLinks.includes(fileName) || existingLinks.includes(fileBaseName)) {
      continue;
    }

    // Look for exact mentions of the note name
    const mentions = findTextMentions(fileContent, fileBaseName);
    
    for (const mention of mentions) {
      suggestions.push({
        targetNote: file,
        suggestionType: "keyword_match",
        confidence: 0.9,
        reason: `Exact mention of note name "${fileBaseName}"`,
        context: extractContextAroundPosition(fileContent, mention.start, contextWindow),
        suggestedText: `[[${fileName}]]`,
        position: mention,
      });
    }
  }

  // Sort by confidence and limit results
  suggestions.sort((a, b) => b.confidence - a.confidence);
  const limitedSuggestions = suggestions.slice(0, maxSuggestions);

  return {
    success: true,
    operation: "find_link_opportunities",
    filePath,
    suggestions: limitedSuggestions,
    statistics: {
      totalSuggestions: suggestions.length,
      highConfidenceSuggestions: suggestions.filter(s => s.confidence > 0.7).length,
      conceptsAnalyzed: 0,
      existingLinks: existingLinks.length,
    },
    message: `Found ${limitedSuggestions.length} link opportunities in the text`,
  };
}

/**
 * Analyze content for linkable concepts and entities.
 */
async function analyzeLinkableConcepts(
  filePath: string | undefined,
  content: string | undefined,
  maxSuggestions: number,
  includeTagSuggestions: boolean,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<SmartLinkingResult> {
  let targetContent: string;

  if (content) {
    targetContent = content;
  } else if (filePath) {
    targetContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  } else {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Either filePath or content must be provided");
  }

  const concepts = extractConcepts(targetContent);
  const analysis: ConceptAnalysis[] = [];

  for (const [concept, frequency] of concepts.entries()) {
    const relatedNotes = await findNotesWithConcept(concept, obsidianService, context);
    const suggestedTags = includeTagSuggestions ? generateTagSuggestions(concept) : [];
    
    analysis.push({
      concept,
      frequency,
      relatedNotes: relatedNotes.slice(0, 5), // Limit to top 5 related notes
      suggestedTags,
      importance: calculateConceptImportance(concept, frequency, relatedNotes.length),
    });
  }

  // Sort by importance and limit results
  analysis.sort((a, b) => b.importance - a.importance);
  const limitedAnalysis = analysis.slice(0, maxSuggestions);

  return {
    success: true,
    operation: "analyze_linkable_concepts",
    filePath,
    concepts: limitedAnalysis,
    statistics: {
      totalSuggestions: 0,
      highConfidenceSuggestions: 0,
      conceptsAnalyzed: analysis.length,
      existingLinks: 0,
    },
    message: `Analyzed ${limitedAnalysis.length} key concepts in the content`,
  };
}

/**
 * Suggest potential backlinks to the current note.
 */
async function suggestBacklinks(
  filePath: string,
  maxSuggestions: number,
  similarityThreshold: number,
  excludeFolders: string[],
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<SmartLinkingResult> {
  const targetContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const allFiles = await obsidianService.listFiles("", context);
  const markdownFiles = allFiles.filter(file => 
    file.endsWith('.md') && 
    file !== filePath &&
    !excludeFolders.some(folder => file.startsWith(folder + '/'))
  );

  const suggestions: LinkSuggestion[] = [];
  const targetKeywords = extractKeywords(targetContent);
  const fileName = filePath.replace(/\.md$/, '');

  for (const file of markdownFiles.slice(0, 100)) {
    try {
      const fileContent = await obsidianService.getFileContent(file, "markdown", context) as string;
      
      // Check if file already links to target
      const existingLinks = extractExistingLinks(fileContent);
      if (existingLinks.includes(fileName)) {
        continue;
      }

      const similarity = calculateContentSimilarity(fileContent, targetContent, targetKeywords);
      
      if (similarity >= similarityThreshold) {
        suggestions.push({
          targetNote: file,
          suggestionType: "backlink_opportunity",
          confidence: similarity,
          reason: `Could benefit from linking to ${filePath} (similarity: ${Math.round(similarity * 100)}%)`,
          context: extractRelevantContext(fileContent, targetKeywords, 100),
        });
      }
    } catch (error) {
      continue;
    }
  }

  // Sort by confidence and limit results
  suggestions.sort((a, b) => b.confidence - a.confidence);
  const limitedSuggestions = suggestions.slice(0, maxSuggestions);

  return {
    success: true,
    operation: "suggest_backlinks",
    filePath,
    suggestions: limitedSuggestions,
    statistics: {
      totalSuggestions: suggestions.length,
      highConfidenceSuggestions: suggestions.filter(s => s.confidence > 0.7).length,
      conceptsAnalyzed: 0,
      existingLinks: 0,
    },
    message: `Found ${limitedSuggestions.length} potential backlink opportunities`,
  };
}

/**
 * Recommend tags based on content analysis.
 */
async function recommendTags(
  filePath: string | undefined,
  content: string | undefined,
  maxSuggestions: number,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<SmartLinkingResult> {
  let targetContent: string;

  if (content) {
    targetContent = content;
  } else if (filePath) {
    targetContent = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  } else {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Either filePath or content must be provided");
  }

  // Extract existing tags to avoid duplicates
  const existingTags = extractExistingTags(targetContent);
  const keywords = extractKeywords(targetContent);
  const concepts = extractConcepts(targetContent);
  
  const tagSuggestions = new Set<string>();

  // Generate tags from keywords
  keywords.slice(0, 20).forEach(keyword => {
    const tag = normalizeTagName(keyword);
    if (tag && !existingTags.includes(tag)) {
      tagSuggestions.add(tag);
    }
  });

  // Generate tags from concepts
  for (const [concept] of Array.from(concepts.entries()).slice(0, 10)) {
    const tag = normalizeTagName(concept);
    if (tag && !existingTags.includes(tag)) {
      tagSuggestions.add(tag);
    }
  }

  const tags = Array.from(tagSuggestions).slice(0, maxSuggestions);

  return {
    success: true,
    operation: "recommend_tags",
    filePath,
    tags,
    statistics: {
      totalSuggestions: tags.length,
      highConfidenceSuggestions: 0,
      conceptsAnalyzed: concepts.size,
      existingLinks: 0,
    },
    message: `Recommended ${tags.length} tags based on content analysis`,
  };
}

/**
 * Find broken or invalid links in a note.
 */
async function findBrokenLinks(
  filePath: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<SmartLinkingResult> {
  const content = await obsidianService.getFileContent(filePath, "markdown", context) as string;
  const allFiles = await obsidianService.listFiles("", context);
  const existingFiles = new Set(allFiles.map(f => f.replace(/\.md$/, '')));
  
  const links = extractExistingLinks(content);
  const brokenLinks: string[] = [];

  for (const link of links) {
    if (!existingFiles.has(link) && !existingFiles.has(link + '.md')) {
      brokenLinks.push(link);
    }
  }

  return {
    success: true,
    operation: "find_broken_links",
    filePath,
    brokenLinks,
    statistics: {
      totalSuggestions: 0,
      highConfidenceSuggestions: 0,
      conceptsAnalyzed: 0,
      existingLinks: links.length,
    },
    message: `Found ${brokenLinks.length} broken links out of ${links.length} total links`,
  };
}

/**
 * Get comprehensive link suggestions combining multiple strategies.
 */
async function getLinkSuggestions(
  filePath: string | undefined,
  content: string | undefined,
  maxSuggestions: number,
  similarityThreshold: number,
  includeExistingLinks: boolean,
  excludeFolders: string[],
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<SmartLinkingResult> {
  // Combine multiple suggestion strategies
  const contentSuggestions = await suggestLinksForContent(
    filePath,
    content,
    Math.ceil(maxSuggestions * 0.6),
    similarityThreshold,
    includeExistingLinks,
    excludeFolders,
    obsidianService,
    context
  );

  const allSuggestions = contentSuggestions.suggestions || [];

  if (filePath) {
    const opportunitySuggestions = await findLinkOpportunities(
      filePath,
      Math.ceil(maxSuggestions * 0.4),
      150,
      excludeFolders,
      obsidianService,
      context
    );
    
    allSuggestions.push(...(opportunitySuggestions.suggestions || []));
  }

  // Remove duplicates and sort by confidence
  const uniqueSuggestions = Array.from(
    new Map(allSuggestions.map(s => [s.targetNote, s])).values()
  );
  uniqueSuggestions.sort((a, b) => b.confidence - a.confidence);
  
  const limitedSuggestions = uniqueSuggestions.slice(0, maxSuggestions);

  return {
    success: true,
    operation: "get_link_suggestions",
    filePath,
    suggestions: limitedSuggestions,
    statistics: {
      totalSuggestions: allSuggestions.length,
      highConfidenceSuggestions: limitedSuggestions.filter(s => s.confidence > 0.7).length,
      conceptsAnalyzed: 0,
      existingLinks: contentSuggestions.statistics?.existingLinks || 0,
    },
    message: `Generated ${limitedSuggestions.length} comprehensive link suggestions`,
  };
}

// Utility functions

function extractExistingLinks(content: string): string[] {
  const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match;

  while ((match = wikilinkRegex.exec(content)) !== null) {
    const link = match[1].includes('|') ? match[1].split('|')[0] : match[1];
    links.push(link);
  }

  return [...new Set(links)];
}

function extractKeywords(content: string): string[] {
  // Remove markdown syntax and extract meaningful words
  const cleanContent = content
    .replace(/[#*_`\[\]()]/g, ' ')
    .replace(/\n+/g, ' ')
    .toLowerCase();
  
  const words = cleanContent.split(/\s+/)
    .filter(word => 
      word.length > 3 && 
      !['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'this', 'that', 'these', 'those', 'from', 'into', 'over', 'under', 'above', 'below'].includes(word)
    );

  // Count frequency and return top keywords
  const frequency = new Map<string, number>();
  words.forEach(word => {
    frequency.set(word, (frequency.get(word) || 0) + 1);
  });

  return Array.from(frequency.entries())
    .sort(([,a], [,b]) => b - a)
    .slice(0, 20)
    .map(([word]) => word);
}

function calculateContentSimilarity(content1: string, content2: string, keywords: string[]): number {
  const words1 = new Set(content1.toLowerCase().split(/\s+/));
  const words2 = new Set(content2.toLowerCase().split(/\s+/));
  
  // Calculate Jaccard similarity
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  let similarity = intersection.size / union.size;
  
  // Boost similarity if important keywords are shared
  const keywordBoost = keywords.filter(keyword => 
    content2.toLowerCase().includes(keyword)
  ).length / keywords.length;
  
  similarity += keywordBoost * 0.3;
  
  return Math.min(1, similarity);
}

function extractRelevantContext(content: string, keywords: string[], maxLength: number): string {
  for (const keyword of keywords) {
    const index = content.toLowerCase().indexOf(keyword);
    if (index !== -1) {
      const start = Math.max(0, index - maxLength / 2);
      const end = Math.min(content.length, index + maxLength / 2);
      return content.substring(start, end).trim();
    }
  }
  
  return content.substring(0, maxLength).trim();
}

function findTextMentions(content: string, searchText: string): Array<{start: number, end: number}> {
  const mentions: Array<{start: number, end: number}> = [];
  const regex = new RegExp(`\\b${searchText}\\b`, 'gi');
  let match;

  while ((match = regex.exec(content)) !== null) {
    mentions.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return mentions;
}

function extractContextAroundPosition(content: string, position: number, windowSize: number): string {
  const start = Math.max(0, position - windowSize / 2);
  const end = Math.min(content.length, position + windowSize / 2);
  return content.substring(start, end).trim();
}

function extractConcepts(content: string): Map<string, number> {
  const concepts = new Map<string, number>();
  
  // Extract noun phrases and capitalized terms
  const conceptRegex = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
  let match;
  
  while ((match = conceptRegex.exec(content)) !== null) {
    const concept = match[0];
    if (concept.length > 2) {
      concepts.set(concept, (concepts.get(concept) || 0) + 1);
    }
  }
  
  return concepts;
}

async function findNotesWithConcept(
  concept: string,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<string[]> {
  try {
    const allFiles = await obsidianService.listFiles("", context);
    const relatedNotes: string[] = [];
    
    for (const file of allFiles.slice(0, 50)) { // Limit for performance
      if (!file.endsWith('.md')) continue;
      
      try {
        const content = await obsidianService.getFileContent(file, "markdown", context) as string;
        if (content.toLowerCase().includes(concept.toLowerCase())) {
          relatedNotes.push(file);
        }
      } catch (error) {
        continue;
      }
    }
    
    return relatedNotes;
  } catch (error) {
    return [];
  }
}

function generateTagSuggestions(concept: string): string[] {
  const tag = normalizeTagName(concept);
  return tag ? [tag] : [];
}

function calculateConceptImportance(concept: string, frequency: number, relatedNotesCount: number): number {
  // Combine frequency and connectivity to determine importance
  const frequencyScore = Math.min(frequency / 10, 1);
  const connectivityScore = Math.min(relatedNotesCount / 5, 1);
  const lengthBonus = concept.length > 10 ? 0.2 : 0;
  
  return (frequencyScore * 0.4 + connectivityScore * 0.5 + lengthBonus) * 100;
}

function extractExistingTags(content: string): string[] {
  const tagRegex = /#[\w-]+/g;
  return Array.from(content.matchAll(tagRegex)).map(match => match[0]);
}

function normalizeTagName(text: string): string | null {
  // Convert text to a valid tag name
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .trim();
  
  return normalized.length > 2 && normalized.length < 30 ? `#${normalized}` : null;
}