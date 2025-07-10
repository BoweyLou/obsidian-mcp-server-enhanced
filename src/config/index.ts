import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

dotenv.config();

// --- Determine Project Root ---
/**
 * Finds the project root directory by searching upwards for package.json.
 * @param startDir The directory to start searching from.
 * @returns The absolute path to the project root, or throws an error if not found.
 */
const findProjectRoot = (startDir: string): string => {
  let currentDir = startDir;
  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached the root of the filesystem without finding package.json
      throw new Error(
        `Could not find project root (package.json) starting from ${startDir}`,
      );
    }
    currentDir = parentDir;
  }
};

let projectRoot: string;
try {
  // For ESM, __dirname is not available directly.
  const currentModuleDir = dirname(fileURLToPath(import.meta.url));
  projectRoot = findProjectRoot(currentModuleDir);
} catch (error: any) {
  console.error(`FATAL: Error determining project root: ${error.message}`);
  projectRoot = process.cwd();
  console.warn(
    `Warning: Using process.cwd() (${projectRoot}) as fallback project root.`,
  );
}
// --- End Determine Project Root ---

const pkgPath = join(projectRoot, "package.json");
let pkg = { name: "obsidian-mcp-server", version: "0.0.0" };

try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
} catch (error) {
  if (process.stderr.isTTY) {
    console.error(
      "Warning: Could not read package.json for default config values. Using hardcoded defaults.",
      error,
    );
  }
}

/**
 * Zod schema for individual vault configuration.
 * @private
 */
const VaultConfigSchema = z.object({
  id: z.string().min(1, "Vault ID cannot be empty"),
  name: z.string().min(1, "Vault name cannot be empty"),
  apiKey: z.string().min(1, "Vault API key cannot be empty"),
  baseUrl: z.string().url("Vault base URL must be a valid URL"),
  verifySsl: z.boolean().default(false),
});

/**
 * Type for individual vault configuration.
 */
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

/**
 * Zod schema for validating environment variables.
 * @private
 */
const EnvSchema = z.object({
  MCP_SERVER_NAME: z.string().optional(),
  MCP_SERVER_VERSION: z.string().optional(),
  MCP_LOG_LEVEL: z.string().default("info"),
  LOGS_DIR: z.string().default(path.join(projectRoot, "logs")),
  NODE_ENV: z.string().default("development"),
  MCP_TRANSPORT_TYPE: z.enum(["stdio", "http"]).default("http"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3010),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  MCP_HTTP_STATELESS: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("false"),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  MCP_AUTH_MODE: z.enum(["jwt", "oauth"]).optional(),
  MCP_AUTH_SECRET_KEY: z
    .string()
    .min(
      32,
      "MCP_AUTH_SECRET_KEY must be at least 32 characters long for security",
    )
    .optional(),
  OAUTH_ISSUER_URL: z.string().url().optional(),
  OAUTH_AUDIENCE: z.string().optional(),
  OAUTH_JWKS_URI: z.string().url().optional(),
  // --- MCP Authentication (for multi-vault support) ---
  MCP_AUTH_KEY: z.string().min(1, "MCP_AUTH_KEY cannot be empty").optional(),
  // --- Multi-vault configuration ---
  OBSIDIAN_VAULTS: z.string().optional(), // JSON string of vault configurations
  // --- Legacy single vault config (for backwards compatibility) ---
  OBSIDIAN_API_KEY: z.string().min(1, "OBSIDIAN_API_KEY cannot be empty").optional(),
  OBSIDIAN_BASE_URL: z.string().url().default("http://127.0.0.1:27123"),
  OBSIDIAN_VERIFY_SSL: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("false"),
  OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  OBSIDIAN_ENABLE_CACHE: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("true"),
  OBSIDIAN_API_SEARCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30000),
});

const parsedEnv = EnvSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const errorDetails = parsedEnv.error.flatten().fieldErrors;
  if (process.stderr.isTTY) {
    console.error("❌ Invalid environment variables:", errorDetails);
  }
  throw new Error(
    `Invalid environment configuration. Please check your .env file or environment variables. Details: ${JSON.stringify(errorDetails)}`,
  );
}

const env = parsedEnv.data;

// Parse vault configurations
let vaultConfigs: Array<{
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  verifySsl: boolean;
}> = [];

let mcpAuthKey: string | undefined;
let isMultiVaultMode = false;

if (env.OBSIDIAN_VAULTS) {
  // Multi-vault mode
  try {
    const vaultsJson = JSON.parse(env.OBSIDIAN_VAULTS);
    if (!Array.isArray(vaultsJson)) {
      throw new Error("OBSIDIAN_VAULTS must be an array");
    }
    
    vaultConfigs = vaultsJson.map((vault, index) => {
      const parsed = VaultConfigSchema.safeParse(vault);
      if (!parsed.success) {
        throw new Error(`Invalid vault configuration at index ${index}: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
      }
      return parsed.data;
    });
    
    if (vaultConfigs.length === 0) {
      throw new Error("OBSIDIAN_VAULTS array cannot be empty");
    }
    
    // Check for duplicate vault IDs
    const vaultIds = vaultConfigs.map(v => v.id);
    const duplicates = vaultIds.filter((id, index) => vaultIds.indexOf(id) !== index);
    if (duplicates.length > 0) {
      throw new Error(`Duplicate vault IDs found: ${duplicates.join(", ")}`);
    }
    
    if (!env.MCP_AUTH_KEY) {
      throw new Error("MCP_AUTH_KEY is required when using multi-vault mode (OBSIDIAN_VAULTS)");
    }
    
    mcpAuthKey = env.MCP_AUTH_KEY;
    isMultiVaultMode = true;
  } catch (error) {
    if (process.stderr.isTTY) {
      console.error("❌ Error parsing OBSIDIAN_VAULTS:", error);
    }
    throw new Error(`Failed to parse OBSIDIAN_VAULTS: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (env.OBSIDIAN_API_KEY) {
  // Legacy single vault mode
  vaultConfigs = [{
    id: "default",
    name: "Default Vault",
    apiKey: env.OBSIDIAN_API_KEY,
    baseUrl: env.OBSIDIAN_BASE_URL,
    verifySsl: env.OBSIDIAN_VERIFY_SSL,
  }];
  // In single vault mode, use the Obsidian API key for MCP auth unless MCP_AUTH_KEY is explicitly set
  mcpAuthKey = env.MCP_AUTH_KEY || env.OBSIDIAN_API_KEY;
  isMultiVaultMode = false;
} else {
  throw new Error("Either OBSIDIAN_VAULTS (multi-vault mode) or OBSIDIAN_API_KEY (single vault mode) must be configured");
}

// --- Directory Ensurance Function ---
const ensureDirectory = (
  dirPath: string,
  rootDir: string,
  dirName: string,
): string | null => {
  const resolvedDirPath = path.isAbsolute(dirPath)
    ? dirPath
    : path.resolve(rootDir, dirPath);

  if (
    !resolvedDirPath.startsWith(rootDir + path.sep) &&
    resolvedDirPath !== rootDir
  ) {
    if (process.stderr.isTTY) {
      console.error(
        `Error: ${dirName} path "${dirPath}" resolves to "${resolvedDirPath}", which is outside the project boundary "${rootDir}".`,
      );
    }
    return null;
  }

  if (!existsSync(resolvedDirPath)) {
    try {
      mkdirSync(resolvedDirPath, { recursive: true });
    } catch (err: unknown) {
      if (process.stderr.isTTY) {
        console.error(
          `Error creating ${dirName} directory at ${resolvedDirPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  } else {
    try {
      if (!statSync(resolvedDirPath).isDirectory()) {
        if (process.stderr.isTTY) {
          console.error(
            `Error: ${dirName} path ${resolvedDirPath} exists but is not a directory.`,
          );
        }
        return null;
      }
    } catch (statError: any) {
      if (process.stderr.isTTY) {
        console.error(
          `Error accessing ${dirName} path ${resolvedDirPath}: ${statError.message}`,
        );
      }
      return null;
    }
  }
  return resolvedDirPath;
};
// --- End Directory Ensurance Function ---

const validatedLogsPath = ensureDirectory(env.LOGS_DIR, projectRoot, "logs");

if (!validatedLogsPath) {
  if (process.stderr.isTTY) {
    console.error(
      "FATAL: Logs directory configuration is invalid or could not be created. Please check permissions and path. Exiting.",
    );
  }
  process.exit(1);
}

/**
 * Main application configuration object.
 */
export const config = {
  pkg,
  mcpServerName: env.MCP_SERVER_NAME || pkg.name,
  mcpServerVersion: env.MCP_SERVER_VERSION || pkg.version,
  logLevel: env.MCP_LOG_LEVEL,
  logsPath: validatedLogsPath,
  environment: env.NODE_ENV,
  mcpTransportType: env.MCP_TRANSPORT_TYPE,
  mcpHttpPort: env.MCP_HTTP_PORT,
  mcpHttpHost: env.MCP_HTTP_HOST,
  mcpHttpStateless: env.MCP_HTTP_STATELESS,
  mcpAllowedOrigins: env.MCP_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  mcpAuthMode: env.MCP_AUTH_MODE,
  mcpAuthSecretKey: env.MCP_AUTH_SECRET_KEY,
  oauthIssuerUrl: env.OAUTH_ISSUER_URL,
  oauthAudience: env.OAUTH_AUDIENCE,
  oauthJwksUri: env.OAUTH_JWKS_URI,
  // --- MCP Authentication ---
  mcpAuthKey: mcpAuthKey!,
  // --- Vault Configuration ---
  vaultConfigs,
  isMultiVaultMode,
  // --- Legacy single vault properties (for backwards compatibility) ---
  obsidianApiKey: env.OBSIDIAN_API_KEY,
  obsidianBaseUrl: env.OBSIDIAN_BASE_URL,
  obsidianVerifySsl: env.OBSIDIAN_VERIFY_SSL,
  obsidianCacheRefreshIntervalMin: env.OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN,
  obsidianEnableCache: env.OBSIDIAN_ENABLE_CACHE,
  obsidianApiSearchTimeoutMs: env.OBSIDIAN_API_SEARCH_TIMEOUT_MS,
};

/**
 * The configured logging level for the application.
 * Exported separately for convenience (e.g., logger initialization).
 * @type {string}
 */
export const logLevel = config.logLevel;

/**
 * The configured runtime environment for the application.
 * Exported separately for convenience.
 * @type {string}
 */
export const environment = config.environment;
