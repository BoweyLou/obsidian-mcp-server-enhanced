import { existsSync, mkdtempSync, readdirSync } from "fs";
import { readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonlAuditLogger } from "../src/utils/internal/jsonlAuditLogger.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "audit-logger-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("JsonlAuditLogger T3.1 ship criteria", () => {
  it("100 sequential ops produce 100 valid JSONL rows", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    const auditor = new JsonlAuditLogger({ enabled: true, logPath });
    const wrapped = auditor.wrapHandler(
      "test_tool",
      async (_params: unknown) => ({ content: [{ type: "text", text: "ok" }] }),
    );

    for (let i = 0; i < 100; i++) {
      await wrapped({ filePath: `note-${i}.md`, vault: "default" });
    }
    await auditor.flush();

    const content = await readFile(logPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(100);

    for (let i = 0; i < lines.length; i++) {
      const row = JSON.parse(lines[i]) as Record<string, unknown>;
      expect(row.tool).toBe("test_tool");
      expect(row.outcome).toBe("success");
      expect(row.error_type).toBeNull();
      expect(typeof row.elapsed_ms).toBe("number");
      expect(typeof row.request_id).toBe("string");
      expect(typeof row.ts).toBe("string");
      expect(row.target_file).toBe(`note-${i}.md`);
      expect(row.vault).toBe("default");
      expect(typeof row.args_bytes).toBe("number");
    }
  });

  it("failing handler produces error row and re-throws original error", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    const auditor = new JsonlAuditLogger({ enabled: true, logPath });
    class CustomBoom extends Error {
      constructor() {
        super("kaboom");
        this.name = "CustomBoom";
      }
    }
    const original = new CustomBoom();
    const wrapped = auditor.wrapHandler("boom_tool", async () => {
      throw original;
    });

    let caught: unknown;
    try {
      await wrapped({ filePath: "x.md" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(original);
    await auditor.flush();

    const content = await readFile(logPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.outcome).toBe("error");
    expect(row.error_type).toBe("CustomBoom");
    expect(row.tool).toBe("boom_tool");
    expect(row.target_file).toBe("x.md");
  });

  it("rotation triggers at maxSizeBytes without dropping rows", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    // Tiny cap (~2 rows per file). Retention set high enough to keep every
    // rotated file for the duration of the test so no rows are evicted.
    const auditor = new JsonlAuditLogger({
      enabled: true,
      logPath,
      maxSizeBytes: 512,
      maxFiles: 60,
    });
    const wrapped = auditor.wrapHandler("rot_tool", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const rowCount = 50;
    for (let i = 0; i < rowCount; i++) {
      await wrapped({ filePath: `f-${i}.md`, vault: "default" });
    }
    await auditor.flush();

    const allFiles = readdirSync(tmpDir).filter((f) =>
      f.startsWith("audit.jsonl"),
    );
    expect(allFiles.length).toBeGreaterThan(1); // confirm rotation happened

    let totalRows = 0;
    for (const f of allFiles) {
      const c = await readFile(path.join(tmpDir, f), "utf8");
      const lines = c.split("\n").filter(Boolean);
      for (const l of lines) {
        const row = JSON.parse(l) as Record<string, unknown>;
        expect(row.tool).toBe("rot_tool");
      }
      totalRows += lines.length;
    }
    expect(totalRows).toBe(rowCount);
  });

  it("MCP_AUDIT_LOG_ENABLED=false is zero-overhead no-op", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    const auditor = new JsonlAuditLogger({ enabled: false, logPath });
    const original = async (p: unknown) => ({ ok: true, p });
    const wrapped = auditor.wrapHandler("test_tool", original);

    // Identity check — when disabled, wrapHandler must return the same reference.
    expect(wrapped).toBe(original);

    // Calling it must not create the log file.
    await wrapped({ filePath: "n.md" });
    await auditor.flush();
    expect(existsSync(logPath)).toBe(false);
  });
});
