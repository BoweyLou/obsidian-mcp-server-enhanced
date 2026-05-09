import http from "http";
import { mkdtempSync } from "fs";
import { rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HealthMetrics,
  handleHealthRequest,
} from "../src/utils/internal/healthMetrics.js";
import { JsonlAuditLogger } from "../src/utils/internal/jsonlAuditLogger.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "health-metrics-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

interface HealthBody {
  uptime_sec: number;
  request_count_last_hour: number;
  error_rate_last_hour: number;
  connection_count: number;
  memory_mb: number;
}

function fetchJson(
  port: number,
  pathStr: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathStr, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("T3.3 /health endpoint and metrics", () => {
  it("/health returns 200 with all 5 fields present and correctly typed", async () => {
    const metrics = new HealthMetrics();
    metrics.recordRequest();
    metrics.incActive();

    const server = http.createServer((_req, res) =>
      handleHealthRequest(res, metrics),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      server.close();
      throw new Error("server.address() did not return AddressInfo");
    }
    try {
      const { status, body } = await fetchJson(addr.port, "/health");
      expect(status).toBe(200);
      const parsed = JSON.parse(body) as HealthBody;
      expect(typeof parsed.uptime_sec).toBe("number");
      expect(typeof parsed.request_count_last_hour).toBe("number");
      expect(typeof parsed.error_rate_last_hour).toBe("number");
      expect(typeof parsed.connection_count).toBe("number");
      expect(typeof parsed.memory_mb).toBe("number");
      expect(parsed.request_count_last_hour).toBe(1);
      expect(parsed.connection_count).toBe(1);
      expect(parsed.memory_mb).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("request_count_last_hour increments after tool calls go through the audit wrapper", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    const metrics = new HealthMetrics();
    const auditor = new JsonlAuditLogger({
      enabled: true,
      logPath,
      metrics,
    });
    const wrapped = auditor.wrapHandler("counter_tool", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    expect(metrics.snapshot().request_count_last_hour).toBe(0);
    for (let i = 0; i < 5; i++) {
      await wrapped({ filePath: `f-${i}.md` });
    }
    await auditor.flush();
    expect(metrics.snapshot().request_count_last_hour).toBe(5);
  });

  it("error_rate_last_hour reflects failed calls (>0 after a forced error)", async () => {
    const logPath = path.join(tmpDir, "audit.jsonl");
    const metrics = new HealthMetrics();
    const auditor = new JsonlAuditLogger({
      enabled: true,
      logPath,
      metrics,
    });

    expect(metrics.snapshot().error_rate_last_hour).toBe(0);

    const ok = auditor.wrapHandler("ok_tool", async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const boom = auditor.wrapHandler("boom_tool", async () => {
      throw new Error("forced");
    });

    await ok({ filePath: "a.md" });
    await ok({ filePath: "b.md" });
    await ok({ filePath: "c.md" });
    try {
      await boom({ filePath: "d.md" });
    } catch {
      // expected
    }
    await auditor.flush();

    const snap = metrics.snapshot();
    expect(snap.request_count_last_hour).toBe(4);
    expect(snap.error_rate_last_hour).toBeGreaterThan(0);
    expect(snap.error_rate_last_hour).toBeCloseTo(0.25, 4); // 1/4
  });
});
