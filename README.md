# Obsidian MCP Server - Enhanced

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP%20SDK-^1.12.1-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-2.1.0-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Enhanced-brightgreen.svg)](https://github.com/BoweyLou/obsidian-mcp-server-enhanced/issues)
[![Original](https://img.shields.io/badge/Fork%20of-cyanheads/obsidian--mcp--server-blue.svg)](https://github.com/cyanheads/obsidian-mcp-server)

**Enhanced Obsidian MCP Server with Claude.ai Remote Integration, Tailscale Support, and Advanced Query Capabilities!**

> **🔥 Enhanced Fork Notice:** This is an enhanced version of the excellent [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) with additional features specifically tailored for remote Claude.ai integration, advanced task querying, and security via Tailscale.

An MCP (Model Context Protocol) server providing comprehensive access to your Obsidian vault. Enables LLMs and AI agents to read, write, search, and manage your notes and files through the [Obsidian Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api).

Built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), this server follows a modular architecture with robust error handling, logging, and security features.

## 🚀 Enhanced Features (This Fork)

### 🌐 **Claude.ai Remote Integration**
Perfect integration with Claude.ai's Remote MCP feature:
- **Native HTTP Transport**: Rebuilt transport layer for Claude.ai compatibility
- **Simple API Key Authentication**: Uses your Obsidian API key in the external URL
- **Zero Configuration**: Works out-of-the-box with Claude.ai Remote MCP servers
- **Production Ready**: Enterprise-grade stability and error handling

### 🔒 **Tailscale Secure Remote Access**
Access your Obsidian vault securely from anywhere:
- **Tailscale Funnel Integration**: Secure HTTPS endpoints with automatic certificates
- **End-to-End Encryption**: All traffic encrypted through Tailscale network
- **No Port Forwarding**: Zero network configuration required
- **Access Control**: Built-in Tailscale ACL support for enterprise security

### 📊 **Enhanced Task & Query System**
Advanced querying capabilities beyond the original:
- **Tasks Plugin Integration**: Deep integration with Obsidian Tasks plugin
- **Advanced Date Parsing**: Natural language date recognition
- **Priority Detection**: Visual and text-based priority parsing
- **Multiple Output Formats**: Table, list, and summary views


## 🚀 Core Capabilities: Obsidian Tools 🛠️

This server equips your AI with specialized tools to interact with your Obsidian vault:

| Tool Name                                                                              | Description                                                     | Key Features                                                                                                                                           |
| :------------------------------------------------------------------------------------- | :-------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`obsidian_read_file`](./src/mcp-server/tools/obsidianReadFileTool/)                   | Retrieves the content and metadata of a specified file.         | - Read in `markdown` or `json` format.<br/>- Case-insensitive path fallback.<br/>- Includes file stats (creation/modification time).                   |
| [`obsidian_update_file`](./src/mcp-server/tools/obsidianUpdateFileTool/)               | Modifies notes using whole-file operations.                     | - `append`, `prepend`, or `overwrite` content.<br/>- Can create files if they don't exist.<br/>- Targets files by path, active note, or periodic note. |
| [`obsidian_search_replace`](./src/mcp-server/tools/obsidianSearchReplaceTool/)         | Performs search-and-replace operations within a target note.    | - Supports string or regex search.<br/>- Options for case sensitivity, whole word, and replacing all occurrences.                                      |
| [`obsidian_global_search`](./src/mcp-server/tools/obsidianGlobalSearchTool/)           | Performs a search across the entire vault.                      | - Text or regex search.<br/>- Filter by path and modification date.<br/>- Paginated results.                                                           |
| [`obsidian_list_files`](./src/mcp-server/tools/obsidianListFilesTool/)                 | Lists files and subdirectories within a specified vault folder. | - Filter by file extension or name regex.<br/>- Provides a formatted tree view of the directory.                                                       |
| [`obsidian_manage_frontmatter`](./src/mcp-server/tools/obsidianManageFrontmatterTool/) | Atomically manages a note's YAML frontmatter.                   | - `get`, `set`, or `delete` frontmatter keys.<br/>- Avoids rewriting the entire file for metadata changes.                                             |
| [`obsidian_manage_tags`](./src/mcp-server/tools/obsidianManageTagsTool/)               | Adds, removes, or lists tags for a note.                        | - Manages tags in both YAML frontmatter and inline content.                                                                                            |
| [`obsidian_delete_file`](./src/mcp-server/tools/obsidianDeleteFileTool/)               | Permanently deletes a specified file from the vault.            | - Case-insensitive path fallback for safety.                                                                                                           |
| [`obsidian_dataview_query`](./src/mcp-server/tools/obsidianDataviewQueryTool/)         | Execute Dataview DQL queries against your vault.                | - Run TABLE, LIST queries using Dataview syntax.<br/>- Query notes by tags, frontmatter, dates.<br/>- Generate reports and analytics.                |
| [`obsidian_task_query`](./src/mcp-server/tools/obsidianTaskQueryTool/)                 | Search and analyze tasks across your vault.                     | - Filter by status, date ranges, priorities.<br/>- Multiple output formats.<br/>- Extract task metadata (due dates, tags).                           |

---

## Table of Contents

| [Overview](#overview) | [Features](#features) | [Installation](#installation) |
| [Configuration](#configuration) | [Project Structure](#project-structure) | [Vault Cache Service](#vault-cache-service) |
| [Tools](#tools) | [Resources](#resources) | [Development](#development) | [License](#license) |

## Overview

The Obsidian MCP Server acts as a bridge, allowing applications (MCP Clients) that understand the Model Context Protocol (MCP) – like advanced AI assistants (LLMs), IDE extensions, or custom scripts – to interact directly and safely with your Obsidian vault.

Instead of complex scripting or manual interaction, your tools can leverage this server to:

- **Automate vault management**: Read notes, update content, manage frontmatter and tags, search across files, list directories, and delete files programmatically.
- **Integrate Obsidian into AI workflows**: Enable LLMs to access and modify your knowledge base as part of their research, writing, or coding tasks.
- **Build custom Obsidian tools**: Create external applications that interact with your vault data in novel ways.

Built on the robust `mcp-ts-template`, this server provides a standardized, secure, and efficient way to expose Obsidian functionality via the MCP standard. It achieves this by communicating with the powerful [Obsidian Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) running inside your vault.

> **Developer Note**: This repository includes a [.clinerules](.clinerules) file that serves as a developer cheat sheet for your LLM coding agent with quick reference for the codebase patterns, file locations, and code snippets.

## Features

### Core Utilities

Leverages the robust utilities provided by the `mcp-ts-template`:

- **Logging**: Structured, configurable logging (file rotation, console, MCP notifications) with sensitive data redaction.
- **Error Handling**: Centralized error processing, standardized error types (`McpError`), and automatic logging.
- **Configuration**: Environment variable loading (`dotenv`) with comprehensive validation.
- **Input Validation/Sanitization**: Uses `zod` for schema validation and custom sanitization logic.
- **Request Context**: Tracking and correlation of operations via unique request IDs.
- **Type Safety**: Strong typing enforced by TypeScript and Zod schemas.
- **HTTP Transport Option**: Native Node.js HTTP server with session management, CORS support, and API key authentication.

### Obsidian Integration

- **Obsidian Local REST API Integration**: Communicates directly with the Obsidian Local REST API plugin via HTTP requests managed by the `ObsidianRestApiService`.
- **Comprehensive Command Coverage**: Exposes key vault operations as MCP tools (see [Tools](#tools) section).
- **Vault Interaction**: Supports reading, updating (append, prepend, overwrite), searching (global text/regex, search/replace), listing, deleting, and managing frontmatter and tags.
- **Targeting Flexibility**: Tools can target files by path, the currently active file in Obsidian, or periodic notes (daily, weekly, etc.).
- **Vault Cache Service**: An intelligent in-memory cache that improves performance and resilience. It caches vault content, provides a fallback for the global search tool if the live API fails, and periodically refreshes to stay in sync.
- **Safety Features**: Case-insensitive path fallbacks for file operations, clear distinction between modification types (append, overwrite, etc.).

## Installation

### Prerequisites

1.  **Obsidian**: You need Obsidian installed.
2.  **Obsidian Local REST API Plugin**: Install and enable the [Obsidian Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) within your Obsidian vault.
3.  **API Key**: Configure an API key within the Local REST API plugin settings in Obsidian. You will need this key to configure the server.
4.  **Node.js & npm**: Ensure you have Node.js (v18 or later recommended) and npm installed.
5.  **Tailscale** (for remote access): Install [Tailscale](https://tailscale.com) and enable Tailscale Funnel for secure remote Claude.ai integration.

> **💡 Quick Setup**: For automatic startup on boot, see the [Auto-Start Setup Guide](./scripts/autostart/README.md) after installation.

### Installation

1.  Clone this enhanced repository:
    ```bash
    git clone https://github.com/BoweyLou/obsidian-mcp-server-enhanced.git
    cd obsidian-mcp-server-enhanced
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Build the project:
    ```bash
    npm run build
    ```
    This compiles the TypeScript code to JavaScript in the `dist/` directory and makes the entry point executable.

## Configuration

### Environment Variables

Configure the server using environment variables.

These variables must be set in the MCP client configuration (e.g., `cline_mcp_settings.json`) or in your environment before starting the server (if running directly).

If running directly, they can be set in a `.env` file in the project root or directly in your environment.

| Variable                              | Description                                               | Required          | Default                  |
| :------------------------------------ | :-------------------------------------------------------- | :---------------- | :----------------------- |
| **`OBSIDIAN_API_KEY`**                | API Key from the Obsidian Local REST API plugin.          | **Yes**           | `undefined`              |
| **`OBSIDIAN_BASE_URL`**               | Base URL of your Obsidian Local REST API.                 | **Yes**           | `http://127.0.0.1:27123` |
| `MCP_TRANSPORT_TYPE`                  | Server transport: `stdio` or `http`.                      | No                | `http`                   |
| `MCP_HTTP_PORT`                       | Port for the HTTP server.                                 | No                | `3010`                   |
| `MCP_HTTP_HOST`                       | Host for the HTTP server.                                 | No                | `127.0.0.1`              |
| `MCP_ALLOWED_ORIGINS`                 | Comma-separated origins for CORS. **Set for production.** | No                | (none)                   |
| `MCP_AUTH_SECRET_KEY`                 | 32+ char secret for JWT auth. **Not used in this version.** | No                | `undefined`              |
| `MCP_LOG_LEVEL`                       | Logging level (`debug`, `info`, `error`, etc.).           | No                | `info`                   |
| `OBSIDIAN_VERIFY_SSL`                 | Set to `false` to disable SSL verification.               | No                | `true`                   |
| `OBSIDIAN_ENABLE_CACHE`               | Set to `true` to enable the in-memory vault cache.        | No                | `true`                   |
| `OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN` | Refresh interval for the vault cache in minutes.          | No                | `10`                     |

### Connecting to the Obsidian API

To connect the MCP server to your Obsidian vault, you need to configure the base URL (`OBSIDIAN_BASE_URL`) and API key (`OBSIDIAN_API_KEY`). The Obsidian Local REST API plugin offers two ways to connect:

1.  **Encrypted (HTTPS) - Default**:

    - The plugin provides a secure `https://` endpoint (e.g., `https://127.0.0.1:27124`).
    - This uses a self-signed certificate, which will cause connection errors by default.
    - **To fix this**, you must set the `OBSIDIAN_VERIFY_SSL` environment variable to `"false"`. This tells the server to trust the self-signed certificate.

2.  **Non-encrypted (HTTP) - Recommended for Simplicity**:
    - In the plugin's settings within Obsidian, you can enable the "Non-encrypted (HTTP) Server".
    - This provides a simpler `http://` endpoint (e.g., `http://127.0.0.1:27123`).
    - When using this URL, you do not need to worry about SSL verification.

**Example `env` configuration for your MCP client:**

_Using the non-encrypted HTTP URL (recommended):_

```json
"env": {
  "OBSIDIAN_API_KEY": "YOUR_API_KEY_FROM_OBSIDIAN_PLUGIN",
  "OBSIDIAN_BASE_URL": "http://127.0.0.1:27123"
}
```

_Using the encrypted HTTPS URL:_

```json
"env": {
  "OBSIDIAN_API_KEY": "YOUR_API_KEY_FROM_OBSIDIAN_PLUGIN",
  "OBSIDIAN_BASE_URL": "https://127.0.0.1:27124",
  "OBSIDIAN_VERIFY_SSL": "false"
}
```

### Local MCP Client Settings (Optional)

> **Note**: For Claude.ai Remote MCP integration, skip this section and use the [Tailscale Remote Access Setup](#-remote-access-setup-tailscale) instead.

For local MCP clients (e.g., Cline), add to your settings (e.g., `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "obsidian-mcp-server": {
      "command": "node",
      "args": ["/path/to/your/obsidian-mcp-server-enhanced/dist/index.js"],
      "env": {
        "OBSIDIAN_API_KEY": "YOUR_OBSIDIAN_API_KEY",
        "OBSIDIAN_BASE_URL": "http://127.0.0.1:27123",
        "OBSIDIAN_VERIFY_SSL": "false",
        "OBSIDIAN_ENABLE_CACHE": "true"
      }
    }
  }
}
```

## 🌐 Remote Access Setup (Tailscale)

For remote access to your Obsidian vault from anywhere, you can use Tailscale to securely expose your MCP server over the internet.

### Prerequisites

1. **Tailscale Account**: Sign up at [tailscale.com](https://tailscale.com)
2. **Tailscale Installed**: Install Tailscale on your machine running the MCP server
3. **Tailscale Funnel Enabled**: Enable Tailscale Funnel for your account

### Setup Steps

1. **Configure HTTP Transport**: Set the MCP server to use HTTP transport:
   ```bash
   export MCP_TRANSPORT_TYPE=http
   export MCP_HTTP_PORT=3010
   ```

2. **Start the MCP Server**: 
   ```bash
   node dist/index.js
   ```

3. **Enable Tailscale Funnel**:
   ```bash
   # Replace 'your-machine-name' with your actual Tailscale machine name
   tailscale funnel 3010
   ```

4. **Get Your Public URL**: Tailscale will provide a public HTTPS URL like:
   ```
   https://your-machine-name.tail123abc.ts.net
   ```

### Claude.ai Remote MCP Configuration (Enhanced)

Add to your Claude.ai Remote MCP servers with simplified authentication:

```json
{
  "url": "https://your-machine-name.tail123abc.ts.net/mcp?api_key=your-obsidian-api-key",
  "name": "Obsidian Vault"
}
```

> **Note**: Claude.ai Remote MCP only supports URL parameter authentication. The API key must be included in the URL as shown above.

### Security Considerations

- **API Key Authentication**: The server uses your Obsidian API key for authentication
- **Tailscale Encryption**: All traffic is encrypted end-to-end by Tailscale
- **Private Network**: Only you can access the server through your Tailscale network
- **Automatic SSL**: Tailscale Funnel provides automatic HTTPS certificates

### Example Usage

Once set up, you can use tools remotely from Claude.ai:

```
Use obsidian_task_query to show me tasks due today with format="table"
```

```
Use obsidian_dataview_query to run: TABLE file.name FROM #meeting WHERE file.cday = date(today)
```

> **🚀 Pro Tip**: For production use, set up [automatic startup on boot](./scripts/autostart/README.md) so your server and Tailscale Funnel start automatically without manual intervention.

## Project Structure

The codebase follows a modular structure within the `src/` directory:

```
src/
├── index.ts           # Entry point: Initializes and starts the server
├── config/            # Configuration loading (env vars, package info)
│   └── index.ts
├── mcp-server/        # Core MCP server logic and capability registration
│   ├── server.ts      # Server setup, transport handling, tool/resource registration
│   ├── resources/     # MCP Resource implementations (currently none)
│   ├── tools/         # MCP Tool implementations (subdirs per tool)
│   └── transports/    # Stdio and HTTP transport logic, auth middleware
├── services/          # Abstractions for external APIs or internal caching
│   └── obsidianRestAPI/ # Typed client for Obsidian Local REST API
├── types-global/      # Shared TypeScript type definitions (errors, etc.)
└── utils/             # Common utility functions (logger, error handler, security, etc.)
```

For a detailed file tree, run `npm run tree` or see [docs/tree.md](docs/tree.md).

## Vault Cache Service

This server includes an intelligent **in-memory cache** designed to enhance performance and resilience when interacting with your vault.

### Purpose and Benefits

- **Performance**: By caching file content and metadata, the server can perform search operations much faster, especially in large vaults. This reduces the number of direct requests to the Obsidian Local REST API, resulting in a snappier experience.
- **Resilience**: The cache acts as a fallback for the `obsidian_global_search` tool. If the live API search fails or times out, the server seamlessly uses the cache to provide results, ensuring that search functionality remains available even if the Obsidian API is temporarily unresponsive.
- **Efficiency**: The cache is designed to be efficient. It performs an initial build on startup and then periodically refreshes in the background by checking for file modifications, ensuring it stays reasonably up-to-date without constant, heavy API polling.

### How It Works

1.  **Initialization**: When enabled, the `VaultCacheService` builds an in-memory map of all `.md` files in your vault, storing their content and modification times.
2.  **Periodic Refresh**: The cache automatically refreshes at a configurable interval (defaulting to 10 minutes). During a refresh, it only fetches content for files that are new or have been modified since the last check.
3.  **Proactive Updates**: After a file is modified through a tool like `obsidian_update_file`, the service proactively updates the cache for that specific file, ensuring immediate consistency.
4.  **Search Fallback**: The `obsidian_global_search` tool first attempts a live API search. If this fails, it automatically falls back to searching the in-memory cache.

### Configuration

The cache is enabled by default but can be configured via environment variables:

- **`OBSIDIAN_ENABLE_CACHE`**: Set to `true` (default) or `false` to enable or disable the cache service.
- **`OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN`**: Defines the interval in minutes for the periodic background refresh. Defaults to `10`.

## Tools

The Obsidian MCP Server provides a suite of tools for interacting with your vault, callable via the Model Context Protocol.

| Tool Name                     | Description                                               | Key Arguments                                                 |
| :---------------------------- | :-------------------------------------------------------- | :------------------------------------------------------------ |
| `obsidian_read_file`          | Retrieves the content and metadata of a file.             | `filePath`, `format?`, `includeStat?`                         |
| `obsidian_update_file`        | Modifies a file by appending, prepending, or overwriting. | `targetType`, `content`, `targetIdentifier?`, `wholeFileMode` |
| `obsidian_search_replace`     | Performs search-and-replace operations in a note.         | `targetType`, `replacements`, `useRegex?`, `replaceAll?`      |
| `obsidian_global_search`      | Searches the entire vault for content.                    | `query`, `searchInPath?`, `useRegex?`, `page?`, `pageSize?`   |
| `obsidian_list_files`         | Lists files and subdirectories in a folder.               | `dirPath`, `fileExtensionFilter?`, `nameRegexFilter?`         |
| `obsidian_manage_frontmatter` | Gets, sets, or deletes keys in a note's frontmatter.      | `filePath`, `operation`, `key`, `value?`                      |
| `obsidian_manage_tags`        | Adds, removes, or lists tags in a note.                   | `filePath`, `operation`, `tags`                               |
| `obsidian_delete_file`        | Permanently deletes a file from the vault.                | `filePath`                                                    |
| `obsidian_dataview_query`     | Execute Dataview DQL queries against your vault.          | `query`, `format?`                                            |
| `obsidian_task_query`         | Search and analyze tasks across your vault.               | `status?`, `dateRange?`, `folder?`, `priority?`, `format?`    |
| `obsidian_periodic_notes`     | Create and manage daily, weekly, monthly, yearly notes.   | `operation`, `periodType`, `date?`, `content?`, `append?`     |
| `obsidian_block_reference`    | Work with block references and heading operations.        | `operation`, `filePath`, `heading?`, `content?`, `blockId?`   |
| `obsidian_graph_analysis`     | Analyze note connections and vault relationships.         | `operation`, `filePath?`, `minConnections?`, `maxDepth?`      |
| `obsidian_template_system`    | Create files from templates with variable substitution.   | `operation`, `templatePath?`, `targetPath?`, `variables?`     |
| `obsidian_smart_linking`      | Get intelligent link suggestions and recommendations.     | `operation`, `filePath?`, `content?`, `maxSuggestions?`       |

_Note: All tools support comprehensive error handling and return structured JSON responses._


## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Attribution

This enhanced version is based on the excellent work by [cyanheads](https://github.com/cyanheads) in the original [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) project. All core functionality and architecture credit goes to the original author.

**Enhancements in this fork:**
- Claude.ai Remote MCP integration and compatibility fixes
- Tailscale Funnel integration for secure remote access
- Enhanced HTTP transport layer with simplified authentication
- Advanced task querying with Tasks plugin integration
- **5 New Advanced Tools**: Periodic notes, block references, graph analysis, template system, and smart linking
- Production-ready configuration for enterprise use

---

<div align="center">
Built with the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a><br>
Enhanced for <a href="https://claude.ai">Claude.ai</a> Remote Integration
</div>
