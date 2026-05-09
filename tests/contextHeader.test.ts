import { mkdtempSync } from "fs";
import { readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HealthMetrics } from "../src/utils/internal/healthMetrics.js";
import {
  JsonlAuditLogger,
  withAuditRequestContext,
} from "../src/utils/internal/jsonlAuditLogger.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "ctx-header-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("T3.2 trace_id + client_type header capture", () => {
  it("populates row.trace_id and row.client_type when withAuditRequestContext supplies them", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    // isolated metrics so concurrent tests don't pollute the singleton
    const auditor = new JsonlAuditLogger({
      enabled: true,
      logPath,
      metrics: new HealthMetrics(),
    });
    const wrapped = auditor.wrapHandler("ctx_tool", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    await withAuditRequestContext(
      { traceId: "abc123def456", clientType: "claude-web/0.1" },
      async () => {
        await wrapped({ filePath: "x.md", vault: "default" });
      },
    );
    await auditor.flush();

    const lines = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.trace_id).toBe("abc123def456");
    expect(typeof row.trace_id).toBe("string");
    expect(row.client_type).toBe("claude-web/0.1");
    expect(typeof row.client_type).toBe("string");
  });

  it("leaves row.trace_id and row.client_type null when no request context is set", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    const auditor = new JsonlAuditLogger({
      enabled: true,
      logPath,
      metrics: new HealthMetrics(),
    });
    const wrapped = auditor.wrapHandler("ctx_tool", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    // No withAuditRequestContext wrap — mirrors the stdio transport path.
    await wrapped({ filePath: "x.md", vault: "default" });
    await auditor.flush();

    const lines = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.trace_id).toBeNull();
    expect(row.client_type).toBeNull();
  });
});
