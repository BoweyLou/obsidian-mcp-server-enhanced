import { IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
import { z } from "zod";
import { config } from "../config/index.js";
import { processObsidianGlobalSearch, ObsidianGlobalSearchInputSchema, ObsidianGlobalSearchResponse } from "../mcp-server/tools/obsidianGlobalSearchTool/logic.js";
import { obsidianCreateTaskLogic, CreateTaskInputSchema, CreateTaskResponse } from "../mcp-server/tools/obsidianCreateTaskTool/logic.js";
import { obsidianTaskQueryLogic, TaskQueryInputSchema, TaskQueryResponse } from "../mcp-server/tools/obsidianTaskQueryTool/logic.js";
import { obsidianUpdateTaskLogic, UpdateTaskInputSchema, UpdateTaskResponse } from "../mcp-server/tools/obsidianUpdateTaskTool/logic.js";
import { ObsidianRestApiService } from "../services/obsidianRestAPI/index.js";
import { VaultManager } from "../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../utils/index.js";

const FetchPageParametersSchema = z.object({
  filePath: z.string().min(1, "filePath is required"),
  format: z.enum(["markdown", "json"]).default("markdown"),
});

const UpdatePageParametersSchema = z.object({
  filePath: z.string().min(1, "filePath is required"),
  content: z.string().min(1, "content cannot be empty"),
  mode: z.enum(["append", "prepend", "overwrite"]).default("append"),
  createIfMissing: z.boolean().default(true),
});

const ChatGptActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("searchNotes"),
    vault: z.string().optional(),
    parameters: ObsidianGlobalSearchInputSchema,
  }),
  z.object({
    action: z.literal("fetchPage"),
    vault: z.string().optional(),
    parameters: FetchPageParametersSchema,
  }),
  z.object({
    action: z.literal("updatePage"),
    vault: z.string().optional(),
    parameters: UpdatePageParametersSchema,
  }),
  z.object({
    action: z.literal("taskQuery"),
    vault: z.string().optional(),
    parameters: TaskQueryInputSchema,
  }),
  z.object({
    action: z.literal("taskCreate"),
    vault: z.string().optional(),
    parameters: CreateTaskInputSchema,
  }),
  z.object({
    action: z.literal("taskUpdate"),
    vault: z.string().optional(),
    parameters: UpdateTaskInputSchema,
  }),
]);

type ChatGptActionRequest = z.infer<typeof ChatGptActionSchema>;

interface ChatGptActionResult {
  vaultId: string;
  payload:
    | ObsidianGlobalSearchResponse
    | TaskQueryResponse
    | CreateTaskResponse
    | UpdateTaskResponse
    | Record<string, unknown>;
}

interface ChatGptActionDescriptor {
  action: ChatGptActionRequest["action"];
  summary: string;
  parameters: string[];
  returns: string;
}

interface ChatGptManifest {
  schemaVersion: string;
  name: string;
  description: string;
  authentication: {
    type: "none" | "query-api-key";
    queryParameter?: string;
  };
  endpoints: {
    manifestUrl: string;
    actionsUrl: string;
    mcpUrl: string;
  };
  actions: ChatGptActionDescriptor[];
  vaults: string[];
  docsUrl?: string;
}

const ACTION_DESCRIPTORS: ChatGptActionDescriptor[] = [
  {
    action: "searchNotes",
    summary: "Full-text, regex, and date-aware vault search with pagination.",
    parameters: [
      "`query` (string, required) – search term or regex.",
      "`searchInPath` (string) – limit search to a folder.",
      "`modified_since` / `modified_until` (string) – natural language timestamps.",
      "`page`/`pageSize` (number) – pagination controls.",
    ],
    returns:
      "Structured match list with paths, context snippets, and pagination metadata.",
  },
  {
    action: "fetchPage",
    summary: "Fetch a markdown page as raw text or full JSON metadata.",
    parameters: [
      "`filePath` (string, required) – vault-relative path.",
      "`format` ('markdown' | 'json') – defaults to markdown.",
    ],
    returns: "Markdown string or NoteJson payload for the requested page.",
  },
  {
    action: "updatePage",
    summary: "Append, prepend, or overwrite a page using safe whole-file writes.",
    parameters: [
      "`filePath` (string, required) – target note.",
      "`mode` ('append' | 'prepend' | 'overwrite') – defaults to append.",
      "`content` (string, required) – text to inject.",
      "`createIfMissing` (boolean) – defaults to true.",
    ],
    returns: "Status object describing whether the file was created or updated.",
  },
  {
    action: "taskQuery",
    summary:
      "Run the Tasks-plugin aware query engine with natural language date ranges.",
    parameters: [
      "`status`, `dateRange`, `priority`, `limit` – match Task Query tool fields.",
      "`folder`, `tags` – optional filters.",
    ],
    returns:
      "Task result set with metadata, summary counts, and formatted output text.",
  },
  {
    action: "taskCreate",
    summary:
      "Create a rich Tasks-plugin compatible task inside a note, heading, or periodic note.",
    parameters: [
      "`text` (string, required) – task body.",
      "`filePath`/`useActiveFile`/`usePeriodicNote` – destination.",
      "`insertAt`, `indentLevel`, `listStyle` – placement controls.",
      "Optional metadata: `dueDate`, `scheduledDate`, `priority`, `tags`, etc.",
    ],
    returns:
      "Created task text, file path, line number, and normalized metadata snapshot.",
  },
  {
    action: "taskUpdate",
    summary:
      "Update a task line (status, metadata, relocation) using the Update Task logic.",
    parameters: [
      "`filePath` (string) and `lineNumber` (number) or `taskId` to locate the task.",
      "Optional changes: `status`, `text`, `priority`, `dueDate`, `moveToHeading`, etc.",
    ],
    returns: "New task text, affected file, and execution metadata.",
  },
];

interface HandleChatGptLayerOptions {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parentContext: RequestContext;
  parseJsonBody: () => Promise<any>;
  ensureAuthenticated: () => boolean;
  vaultManager: VaultManager;
  mcpEndpointPath: string;
}

export async function handleChatGptLayerRequest(
  options: HandleChatGptLayerOptions,
): Promise<boolean> {
  if (!config.chatgptLayerEnabled) {
    return false;
  }

  const { url, req, res } = options;
  const manifestPath = config.chatgptManifestPath;
  const actionsPath = config.chatgptActionsPath;

  if (url.pathname === manifestPath) {
    if (req.method !== "GET") {
      sendJson(res, 405, {
        success: false,
        error: "Method Not Allowed",
        allowed: ["GET"],
      });
      return true;
    }

    const manifest = buildManifest(options);
    sendJson(res, 200, {
      success: true,
      manifest,
    });
    return true;
  }

  if (url.pathname === actionsPath) {
    if (req.method === "OPTIONS") {
      sendJson(res, 200, { success: true });
      return true;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, {
        success: false,
        error: "Method Not Allowed",
        allowed: ["POST"],
      });
      return true;
    }

    if (!options.ensureAuthenticated()) {
      sendJson(res, 401, {
        success: false,
        error: "Unauthorized",
        message: "Missing or invalid MCP API key.",
      });
      return true;
    }

    let rawBody: unknown;
    try {
      rawBody = await options.parseJsonBody();
    } catch (error) {
      const parseContext = requestContextService.createRequestContext({
        ...options.parentContext,
        operation: "ChatGPT_ParseJsonBody",
        error: error instanceof Error ? error.message : String(error),
      });
      logger.warning("ChatGPT action JSON parsing failed", parseContext);
      sendJson(res, 400, {
        success: false,
        error: "Invalid JSON payload",
      });
      return true;
    }

    const parsed = ChatGptActionSchema.safeParse(rawBody);
    if (!parsed.success) {
      sendJson(res, 400, {
        success: false,
        error: "ValidationError",
        details: parsed.error.flatten(),
      });
      return true;
    }

    try {
      const actionResult = await executeAction(parsed.data, options);
      sendJson(res, 200, {
        success: true,
        action: parsed.data.action,
        vault: actionResult.vaultId,
        data: actionResult.payload,
      });
    } catch (error) {
      handleActionError(error, parsed.data.action, res, options.parentContext);
    }
    return true;
  }

  return false;
}

function buildManifest(options: HandleChatGptLayerOptions): ChatGptManifest {
  const origin = `${options.url.protocol}//${options.url.host}`;
  return {
    schemaVersion: "2025-02-01",
    name: `${config.mcpServerName} ChatGPT MCP Bridge`,
    description:
      "HTTP manifest describing the Obsidian MCP streamable endpoint plus lightweight JSON actions for ChatGPT-managed workflows.",
    authentication: config.mcpAuthKey
      ? {
          type: "query-api-key",
          queryParameter: "api_key",
        }
      : { type: "none" },
    endpoints: {
      manifestUrl: `${origin}${config.chatgptManifestPath}`,
      actionsUrl: `${origin}${config.chatgptActionsPath}`,
      mcpUrl: `${origin}${options.mcpEndpointPath}`,
    },
    actions: ACTION_DESCRIPTORS,
    vaults: options.vaultManager.getAvailableVaults(),
    docsUrl:
      "https://github.com/BoweyLou/obsidian-mcp-server-enhanced#chatgpt-mcp-layer",
  };
}

async function executeAction(
  request: ChatGptActionRequest,
  options: HandleChatGptLayerOptions,
): Promise<ChatGptActionResult> {
  const vaultId = resolveVaultId(
    request.vault,
    "vault" in request.parameters &&
      typeof request.parameters.vault === "string"
      ? request.parameters.vault
      : undefined,
    options.vaultManager,
  );

  const actionContext = requestContextService.createRequestContext({
    ...options.parentContext,
    operation: `ChatGPT_${request.action}`,
    vaultId,
    component: "ChatGPTLayer",
  });

  const obsidianService = options.vaultManager.getVaultService(
    vaultId,
    actionContext,
  );

  switch (request.action) {
    case "searchNotes": {
      const cacheService =
        options.vaultManager.getVaultCacheService(vaultId, actionContext);
      const payload = await processObsidianGlobalSearch(
        request.parameters,
        actionContext,
        obsidianService,
        cacheService,
      );
      return { vaultId, payload };
    }
    case "fetchPage": {
      const { filePath, format } = request.parameters;
      const content = await obsidianService.getFileContent(
        filePath,
        format,
        actionContext,
      );
      return {
        vaultId,
        payload: { filePath, format, content },
      };
    }
    case "updatePage": {
      const payload = await updatePageContent(
        request.parameters,
        obsidianService,
        actionContext,
      );
      return { vaultId, payload };
    }
    case "taskQuery": {
      const payload = await obsidianTaskQueryLogic(
        {
          ...request.parameters,
          vault: vaultId,
        },
        actionContext,
        obsidianService,
      );
      return { vaultId, payload };
    }
    case "taskCreate": {
      const payload = await obsidianCreateTaskLogic(
        request.parameters,
        actionContext,
        obsidianService,
      );
      return { vaultId, payload };
    }
    case "taskUpdate": {
      const payload = await obsidianUpdateTaskLogic(
        request.parameters,
        actionContext,
        obsidianService,
      );
      return { vaultId, payload };
    }
    default:
      return assertNeverAction(request);
  }
}

function assertNeverAction(request: never): never {
  const action =
    (request as ChatGptActionRequest | undefined)?.action ?? "unknown";
  throw new McpError(
    BaseErrorCode.UNKNOWN_ERROR,
    `Unsupported ChatGPT action: ${action}`,
  );
}

function resolveVaultId(
  topLevelVault: string | undefined,
  payloadVault: string | undefined,
  vaultManager: VaultManager,
): string {
  if (topLevelVault?.trim()) {
    return topLevelVault.trim();
  }
  if (payloadVault?.trim()) {
    return payloadVault.trim();
  }
  return vaultManager.getDefaultVaultId();
}

async function updatePageContent(
  params: z.infer<typeof UpdatePageParametersSchema>,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const { filePath, content, mode, createIfMissing } = params;
  let created = false;

  if (mode === "append") {
    try {
      await obsidianService.appendFileContent(filePath, content, context);
    } catch (error) {
      if (
        createIfMissing &&
        error instanceof McpError &&
        error.code === BaseErrorCode.NOT_FOUND
      ) {
        await obsidianService.updateFileContent(filePath, content, context);
        created = true;
      } else {
        throw error;
      }
    }
  } else if (mode === "overwrite") {
    if (!createIfMissing) {
      await obsidianService.getFileContent(filePath, "markdown", context);
    }
    await obsidianService.updateFileContent(filePath, content, context);
  } else if (mode === "prepend") {
    let existing = "";
    try {
      const current = await obsidianService.getFileContent(
        filePath,
        "markdown",
        context,
      );
      existing = typeof current === "string" ? current : "";
    } catch (error) {
      if (
        createIfMissing &&
        error instanceof McpError &&
        error.code === BaseErrorCode.NOT_FOUND
      ) {
        existing = "";
        created = true;
      } else {
        throw error;
      }
    }
    const newContent = existing
      ? `${content}\n${existing}`
      : `${content}\n`;
    await obsidianService.updateFileContent(filePath, newContent, context);
  }

  const message = created
    ? "File created and updated"
    : "File updated successfully";

  return {
    filePath,
    mode,
    created,
    message,
    contentLength: content.length,
  };
}

function handleActionError(
  error: unknown,
  action: string,
  res: ServerResponse,
  parentContext: RequestContext,
) {
  if (error instanceof McpError) {
    sendJson(res, mapErrorCodeToStatus(error.code), {
      success: false,
      action,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  const logContext: RequestContext = {
    ...parentContext,
    action,
    component: "ChatGPTLayer",
  };
  if (!(error instanceof Error)) {
    logContext.rawError = error;
  }
  const errObject = error instanceof Error ? error : undefined;
  logger.error(
    "ChatGPT action failed with unexpected error",
    errObject,
    logContext,
  );

  sendJson(res, 500, {
    success: false,
    action,
    error: {
      code: BaseErrorCode.INTERNAL_ERROR,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function mapErrorCodeToStatus(code: BaseErrorCode): number {
  switch (code) {
    case BaseErrorCode.UNAUTHORIZED:
      return 401;
    case BaseErrorCode.FORBIDDEN:
      return 403;
    case BaseErrorCode.NOT_FOUND:
      return 404;
    case BaseErrorCode.CONFLICT:
      return 409;
    case BaseErrorCode.VALIDATION_ERROR:
    case BaseErrorCode.PARSING_ERROR:
      return 400;
    case BaseErrorCode.RATE_LIMITED:
      return 429;
    case BaseErrorCode.TIMEOUT:
      return 504;
    case BaseErrorCode.SERVICE_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
