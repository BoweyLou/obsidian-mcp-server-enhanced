/**
 * @fileoverview T2.2 — Write lock for serializing concurrent writes to the
 * same vault file.
 *
 * Two layers of protection:
 *  1. **In-process mutex** — `Map<key, Promise>` chain. The realistic
 *     concurrency case (two near-simultaneous tool calls from Claude in this
 *     same MCP server) is fully serialized here. No timeout — calls queue.
 *  2. **OS temp-dir lock file** — best-effort cross-process visibility for
 *     the rare case where another MCP server, REST client, or background
 *     process is also writing. Stale-after-30s policy: if a lock file is
 *     older than the TTL, we log and take over rather than block forever.
 *
 * Wired into `runWriteTool` via `opts.lockKey`. Tools pass a key like
 * `${vaultId}:${filePath}` so writes to different files (or different
 * vaults) don't block each other.
 *
 * @module src/utils/internal/writeLock
 */
import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";
import { buildStructuredError, StructuredError } from "./structuredError.js";

/** Stale-lock TTL — older than this, file lock is considered abandoned. */
export const LOCK_TTL_MS = 30_000;

/** Maximum time to wait for an in-flight cross-process lock. */
const FILE_LOCK_WAIT_TIMEOUT_MS = 30_000;

/** Poll cadence while waiting on a foreign-process lock file. */
const FILE_LOCK_POLL_INTERVAL_MS = 100;

/**
 * In-process mutex chain keyed by the caller's `lockKey`. Each call appends
 * to its key's chain by awaiting the previous "completion sentinel" before
 * proceeding. Errors do not poison the chain — sentinels swallow them so the
 * next waiter can run.
 */
const inProcessChains = new Map<string, Promise<void>>();

interface LockFileMeta {
  pid: number;
  acquired_at: number;
  key: string;
}

export class WriteLockTimeoutError extends Error {
  public readonly structured: StructuredError;
  constructor(key: string, holder: LockFileMeta | null) {
    const heldBy = holder
      ? ` (held by pid=${holder.pid} since ${new Date(holder.acquired_at).toISOString()})`
      : "";
    const message = `Timed out waiting for write lock on '${key}' after ${FILE_LOCK_WAIT_TIMEOUT_MS}ms${heldBy}.`;
    super(message);
    this.name = "WriteLockTimeoutError";
    this.structured = buildStructuredError("lock_timeout", message, {
      operation: "acquireWriteLock",
      lock_key: key,
      holder_pid: holder?.pid,
      holder_acquired_at: holder?.acquired_at,
    });
  }
}

function safeFilename(key: string): string {
  // Hash to a deterministic short filename — keeps cross-platform safe and
  // avoids leaking vault paths into the temp dir.
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `obsidian-mcp-${hash}.lock`;
}

function lockFilePath(key: string): string {
  return join(tmpdir(), safeFilename(key));
}

function readLockFile(path: string): LockFileMeta | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.pid === "number" &&
      typeof parsed.acquired_at === "number"
    ) {
      return parsed as LockFileMeta;
    }
    return null;
  } catch {
    return null;
  }
}

function isStale(meta: LockFileMeta | null): boolean {
  if (!meta) return true;
  return Date.now() - meta.acquired_at > LOCK_TTL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(
  key: string,
  context: RequestContext,
): Promise<void> {
  const path = lockFilePath(key);
  const start = Date.now();

  while (true) {
    try {
      const fd = openSync(path, "wx");
      const meta: LockFileMeta = {
        pid: process.pid,
        acquired_at: Date.now(),
        key,
      };
      writeFileSync(fd, JSON.stringify(meta));
      closeSync(fd);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Filesystem error unrelated to contention — log and proceed without
        // the cross-process lock. The in-process mutex still protects us.
        logger.warning(
          `writeLock: cross-process lock create failed for '${key}' (${code ?? "unknown"}); continuing with in-process lock only.`,
          {
            ...context,
            operation: "acquireFileLock",
            lock_key: key,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return;
      }

      // EEXIST — read the existing lock to decide stale-takeover vs. wait.
      const meta = readLockFile(path);
      if (isStale(meta)) {
        try {
          unlinkSync(path);
          logger.info(
            `writeLock: removed stale lock for '${key}' (age=${
              meta ? Date.now() - meta.acquired_at : "unparseable"
            }ms, holder pid=${meta?.pid ?? "unknown"})`,
            { ...context, operation: "acquireFileLock", lock_key: key },
          );
          continue;
        } catch {
          // Race — someone else cleared/recreated. Loop and retry.
          continue;
        }
      }

      if (Date.now() - start > FILE_LOCK_WAIT_TIMEOUT_MS) {
        throw new WriteLockTimeoutError(key, meta);
      }
      await sleep(FILE_LOCK_POLL_INTERVAL_MS);
    }
  }
}

function releaseFileLock(key: string, context: RequestContext): void {
  const path = lockFilePath(key);
  try {
    unlinkSync(path);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warning(
        `writeLock: failed to release cross-process lock for '${key}' (${code ?? "unknown"})`,
        {
          ...context,
          operation: "releaseFileLock",
          lock_key: key,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}

/**
 * Run `fn` while holding the write lock on `key`. Concurrent calls with the
 * same key are serialized:
 *   - In-process callers queue behind each other (no timeout — fairness).
 *   - Cross-process holders are observed via a temp-dir lock file with a 30s
 *     stale TTL; we wait up to 30s before throwing `WriteLockTimeoutError`.
 *
 * Errors thrown by `fn` propagate to the caller after the lock is released.
 * Errors do not poison the in-process chain — subsequent callers proceed.
 */
export async function acquireWriteLock<T>(
  key: string,
  fn: () => Promise<T>,
  context: RequestContext,
): Promise<T> {
  const prev = inProcessChains.get(key) ?? Promise.resolve();

  const work = (async (): Promise<T> => {
    await prev;
    await acquireFileLock(key, context);
    try {
      return await fn();
    } finally {
      releaseFileLock(key, context);
    }
  })();

  const sentinel = work.then(
    () => undefined,
    () => undefined,
  );
  inProcessChains.set(key, sentinel);

  try {
    return await work;
  } finally {
    if (inProcessChains.get(key) === sentinel) {
      inProcessChains.delete(key);
    }
  }
}

/** Test/diagnostics helper: number of keys with active in-process chains. */
export function activeLockCount(): number {
  return inProcessChains.size;
}

/**
 * Build a write-lock key from a vault id and a target descriptor. Tools call
 * this from registration.ts to keep the format consistent across the suite.
 *
 * `target` should uniquely identify the file being written. For activeFile
 * targets, pass `"__active__"` (a single global slot per vault); for
 * periodic notes, pass `"__periodic_${period}__"`. Returns `undefined` when
 * no usable target is available (skips locking).
 */
export function buildWriteLockKey(
  vaultId: string | undefined,
  target: string | undefined,
): string | undefined {
  if (!target) return undefined;
  return `${vaultId ?? "default"}:${target}`;
}
