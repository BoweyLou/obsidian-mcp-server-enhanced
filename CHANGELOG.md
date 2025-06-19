# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2025-06-20

### Added

- **🔍 Dataview Query Integration**: New `obsidian_dataview_query` tool for executing Dataview DQL queries
  - Run TABLE, LIST queries using Dataview syntax
  - Query notes by tags, frontmatter, creation dates, and content
  - Generate reports and analytics from your vault
  - Support for multiple output formats (table, list, raw)

- **📋 Advanced Task Management**: New `obsidian_task_query` tool for comprehensive task analysis
  - Smart task status detection: incomplete `- [ ]`, completed `- [x]`, in-progress `- [/]`, cancelled `- [-]`
  - Date-based filtering: find tasks due today, completed yesterday, or within custom date ranges
  - Priority recognition: High 🔴, Medium 🟡, Low 🟢 priorities plus text-based indicators
  - Metadata extraction: due dates 📅, completion dates ✅, tags, and project associations
  - Multiple output formats: list, table, or summary views

- **🌐 Remote Access Documentation**: Comprehensive setup guide for Tailscale remote access
  - Zero-config networking setup instructions
  - Claude.ai Remote MCP server integration guide
  - Security considerations and best practices
  - Example usage patterns for remote vault access

### Changed

- **Enhanced Task Parsing**: Improved task metadata extraction following obsidian-tasks plugin standards
- **Better Date Filtering**: More accurate date-based filtering for task queries
- **Documentation Updates**: Added "What's New" section highlighting advanced features
- **Version Bump**: Updated to v2.1.0 to reflect significant new functionality

### Fixed

- **Date Range Filtering**: Fixed incorrect date filtering logic in task queries
- **Task Status Recognition**: Improved task checkbox parsing for various markdown formats

## [2.0.4] - 2025-06-13

### Added

- **Recursive File Listing**: The `obsidian_list_files` tool now supports recursive listing of directories with a `recursionDepth` parameter.

### Changed

- **Documentation**:
  - Consolidated tool specifications into `obsidian_mcp_tools_spec.md`.
  - Updated `.clinerules` with a detailed logger implementation example for the agent.
  - Updated the repository's directory tree documentation.

## [2.0.3] - 2025-06-12

### Fixed

- **NPM Package Display**: Explicitly included `README.md`, `LICENSE`, and `CHANGELOG.md` in the `files` array in `package.json` to ensure they are displayed correctly on the npm package page.

## [2.0.2] - 2025-06-12

### Fixed

- **NPM Package Version**: Bad npm package. Bumping to v2.0.2 for publishing.

## [2.0.1] - 2025-06-12

### Added

- **Enhanced Documentation**:
  - Added a warning to the `VaultCacheService` documentation about its potential for high memory usage on large vaults.
  - Added a code comment in `obsidianManageFrontmatterTool` to clarify the regex-based key deletion strategy.

### Changed

- **Improved SSL Handling**: The `OBSIDIAN_VERIFY_SSL` environment variable is now correctly parsed as a boolean, ensuring more reliable SSL verification behavior.
- **API Service Refactoring**: Simplified the `httpsAgent` handling within the `ObsidianRestApiService` to improve code clarity and remove redundant agent creation on each request.

### Fixed

- **Path Import Correction**: Corrected a path import in the `obsidianGlobalSearchTool` to use `node:path/posix` for better cross-platform compatibility.

## [2.0.0] - 2025-06-12

Version 2.0.0 is a complete overhaul of the Obsidian MCP Server, migrating it to my [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template). This release introduces a more robust architecture, a streamlined toolset, enhanced security, and significant performance improvements. It is a breaking change from the 1.x series.

### Added

- **New Core Architecture**: The server is now built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), providing a standardized, modular, and maintainable structure.
- **Hono HTTP Transport**: The HTTP transport has been migrated from Express to Hono, offering a more lightweight and performant server.
- **Vault Cache Service**: A new in-memory `VaultCacheService` has been introduced. It caches vault content to improve performance for search operations and provides a resilient fallback if the Obsidian API is temporarily unavailable. It also refreshes periodically.
- **Advanced Authentication**:
  - Added support for **OAuth 2.1** bearer token validation alongside the existing secret key-based JWTs.
  - Introduced `authContext` using `AsyncLocalStorage` for secure, request-scoped access to authentication details.
- **New Tools**:
  - `obsidian_delete_file`: A new tool to permanently delete files from the vault.
  - `obsidian_search_replace`: A powerful new tool to perform search and replace operations with regex support.
- **Enhanced Utilities**:
  - **Request Context**: A robust request context system (`requestContextService`) for improved logging and tracing.
  - **Error Handling**: A centralized `ErrorHandler` for consistent and detailed error reporting.
  - **Async Utilities**: A `retryWithDelay` utility is now used across the application to make API calls more resilient.
- **New Development Scripts**: Added `docs:generate` (for TypeDoc) and `inspect:stdio`/`inspect:http` (for MCP Inspector) to `package.json`.

### Changed

- **Project Structure**: The entire project has been reorganized to align with the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), improving separation of concerns (e.g., `services`, `mcp-server`, `types-global`).
- **Tool Consolidation and Enhancement**: The toolset has been redesigned for clarity and power:
  - `obsidian_list_files` replaces `obsidian_list_files_in_vault` and `obsidian_list_files_in_dir`, offering more flexible filtering.
  - `obsidian_read_file` replaces `obsidian_get_file_contents` and now supports returning content as structured JSON.
  - `obsidian_update_file` replaces `obsidian_append_content` and `obsidian_update_content` with explicit modes (`append`, `prepend`, `overwrite`).
  - `obsidian_global_search` replaces `obsidian_find_in_file` with added support for path/date filtering and pagination.
  - `obsidian_manage_frontmatter` replaces `obsidian_get_properties` and `obsidian_update_properties` with atomic get/set/delete operations.
  - `obsidian_manage_tags` replaces `obsidian_get_tags` and now manages both frontmatter and inline tags.
- **Configuration Overhaul**: Environment variables have been renamed for consistency and clarity.
  - `OBSIDIAN_BASE_URL` now consolidates protocol, host, and port.
  - New variables like `MCP_TRANSPORT_TYPE`, `MCP_LOG_LEVEL`, and `MCP_AUTH_SECRET_KEY` have been introduced.
- **Dependency Updates**: All dependencies, including the MCP SDK, have been updated to their latest stable versions.
- **Obsidian API Service**: The `ObsidianRestApiService` has been completely refactored into a modular class, providing a typed, resilient, and centralized client for all interactions with the Obsidian Local REST API.

### Removed

- **Removed Tools**: The following tools from version 1.x have been removed and their functionality integrated into the new, more comprehensive tools:
  - `obsidian_list_files_in_vault`
  - `obsidian_list_files_in_dir`
  - `obsidian_get_file_contents`
  - `obsidian_append_content`
  - `obsidian_update_content`
  - `obsidian_find_in_file`
  - `obsidian_complex_search` (path-based searching is now a filter in `obsidian_global_search`)
  - `obsidian_get_tags`
  - `obsidian_get_properties`
  - `obsidian_update_properties`
- **Removed Resources**: The `obsidian://tags` resource has been removed. Tag information is now available through the `obsidian_manage_tags` tool. I may add the resource back in the future if there is demand for it. Please open an issue if you would like to see it return.
- **Old Configuration**: All old, non-prefixed environment variables (e.g., `VERIFY_SSL`, `REQUEST_TIMEOUT`) have been removed in favor of the new, standardized configuration schema.
