/**
 * @fileoverview T1.4 — In-memory idempotency cache for write tools.
 *
 * Closes BUG-014 (delete+rewrite race): when the LLM client retries a write
 * after a perceived stall, a duplicate UUID short-circuits to the cached
 * result instead of running the side effect twice. Resets on server restart,
 * which is acceptable: the 60s TTL is the only guarantee.
 *
 * @module src/utils/internal/idempotencyStore
 */
import { logger } from "./logger.js";
import { requestContextService } from "./requestContext.js";

export interface IdempotencyEntry<T = unknown> {
  result: T;
  toolName: string;
  storedAt: number;
}

export interface IdempotencyHit<T> {
  hit: true;
  entry: IdempotencyEntry<T>;
}

export interface IdempotencyMiss {
  hit: false;
}

const DEFAULT_TTL_MS = 60_000;
const GC_INTERVAL_MS = 30_000;

export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;
  private gcHandle: NodeJS.Timeout | null = null;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Composite key so two tools using identical UUIDs cannot collide. */
  private composite(toolName: string, key: string): string {
    return `${toolName}::${key}`;
  }

  public lookup<T>(toolName: string, key: string): IdempotencyHit<T> | IdempotencyMiss {
    const composite = this.composite(toolName, key);
    const entry = this.entries.get(composite) as IdempotencyEntry<T> | undefined;
    if (!entry) return { hit: false };
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(composite);
      return { hit: false };
    }
    return { hit: true, entry };
  }

  public store<T>(toolName: string, key: string, result: T): void {
    const composite = this.composite(toolName, key);
    this.entries.set(composite, {
      result,
      toolName,
      storedAt: Date.now(),
    });
  }

  public size(): number {
    return this.entries.size;
  }

  public clear(): void {
    this.entries.clear();
  }

  public startGarbageCollector(): void {
    if (this.gcHandle) return;
    this.gcHandle = setInterval(() => this.gc(), GC_INTERVAL_MS);
    if (typeof this.gcHandle.unref === "function") this.gcHandle.unref();
  }

  public stopGarbageCollector(): void {
    if (this.gcHandle) {
      clearInterval(this.gcHandle);
      this.gcHandle = null;
    }
  }

  private gc(): void {
    const cutoff = Date.now() - this.ttlMs;
    let removed = 0;
    for (const [k, entry] of this.entries.entries()) {
      if (entry.storedAt < cutoff) {
        this.entries.delete(k);
        removed += 1;
      }
    }
    if (removed > 0) {
      logger.debug(
        `IdempotencyStore GC: pruned ${removed} expired entries`,
        requestContextService.createRequestContext({
          operation: "IdempotencyStoreGC",
          remaining: this.entries.size,
        }),
      );
    }
  }
}

let singleton: IdempotencyStore | undefined;

export function getIdempotencyStore(): IdempotencyStore {
  if (!singleton) {
    singleton = new IdempotencyStore();
    singleton.startGarbageCollector();
  }
  return singleton;
}

/** Test-only — replace the singleton with a fresh instance. */
export function _resetIdempotencyStoreForTests(): void {
  if (singleton) singleton.stopGarbageCollector();
  singleton = undefined;
}
