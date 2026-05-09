/**
 * Vitest setup file. Runs before any test module loads.
 * Ensures the env vars validated by src/config/index.ts have safe defaults
 * so importing source modules in tests does not throw on missing config.
 *
 * dotenv.config() (called inside src/config/index.ts) does not overwrite
 * existing process.env entries, so values set here take precedence.
 */
process.env.OBSIDIAN_API_KEY ||= "test-obsidian-api-key";
process.env.OBSIDIAN_BASE_URL ||= "http://127.0.0.1:27123";
process.env.NODE_ENV ||= "test";
process.env.MCP_LOG_LEVEL ||= "error";
