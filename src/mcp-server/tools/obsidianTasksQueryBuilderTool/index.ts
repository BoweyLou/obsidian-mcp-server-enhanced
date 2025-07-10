/**
 * @fileoverview Index file for the Obsidian Tasks Query Builder tool.
 * Re-exports the registration function and core types for easy importing.
 * @module obsidianTasksQueryBuilderTool
 */

export { registerObsidianTasksQueryBuilderTool } from "./registration.js";
export type {
  TasksQueryBuilderInput,
  TasksQueryBuilderResponse,
} from "./logic.js";
export { TasksQueryBuilderInputSchema } from "./logic.js";