/**
 * @fileoverview T3.3 in-memory health metrics + /health endpoint handler.
 *
 * Tracks per-tool-call request and error timestamps over a rolling 1-hour
 * window, plus current in-flight HTTP request count. All state is in-memory
 * and resets on server restart, which is acceptable for V3.23a observability.
 *
 * @module src/utils/internal/healthMetrics
 */
import type { ServerResponse } from "http";

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface HealthSnapshot {
  uptime_sec: number;
  request_count_last_hour: number;
  error_rate_last_hour: number;
  connection_count: number;
  memory_mb: number;
}

export class HealthMetrics {
  private readonly startTime: number;
  private readonly nowFn: () => number;
  private readonly requestTimestamps: number[] = [];
  private readonly errorTimestamps: number[] = [];
  private active = 0;

  constructor(nowFn: () => number = Date.now) {
    this.nowFn = nowFn;
    this.startTime = nowFn();
  }

  public recordRequest(): void {
    this.requestTimestamps.push(this.nowFn());
    this.prune();
  }

  public recordError(): void {
    this.errorTimestamps.push(this.nowFn());
    this.prune();
  }

  public incActive(): void {
    this.active += 1;
  }

  public decActive(): void {
    if (this.active > 0) this.active -= 1;
  }

  public snapshot(): HealthSnapshot {
    this.prune();
    const reqs = this.requestTimestamps.length;
    const errs = this.errorTimestamps.length;
    const errorRate =
      reqs > 0 ? Math.round((errs / reqs) * 10000) / 10000 : 0;
    return {
      uptime_sec: Math.round((this.nowFn() - this.startTime) / 1000),
      request_count_last_hour: reqs,
      error_rate_last_hour: errorRate,
      connection_count: this.active,
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  }

  private prune(): void {
    const cutoff = this.nowFn() - ONE_HOUR_MS;
    while (
      this.requestTimestamps.length > 0 &&
      this.requestTimestamps[0] < cutoff
    ) {
      this.requestTimestamps.shift();
    }
    while (
      this.errorTimestamps.length > 0 &&
      this.errorTimestamps[0] < cutoff
    ) {
      this.errorTimestamps.shift();
    }
  }
}

let singleton: HealthMetrics | undefined;
export function getHealthMetrics(): HealthMetrics {
  if (!singleton) {
    singleton = new HealthMetrics();
  }
  return singleton;
}

/** Test-only — drops the singleton so the next getHealthMetrics() yields a fresh instance. */
export function _resetHealthMetricsSingletonForTests(): void {
  singleton = undefined;
}

/**
 * Writes a 200 JSON response with the current snapshot.
 * Extracted from the HTTP transport so it can be unit-tested directly.
 */
export function handleHealthRequest(
  res: ServerResponse,
  metrics: HealthMetrics = getHealthMetrics(),
): void {
  const snap = metrics.snapshot();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(snap));
}
