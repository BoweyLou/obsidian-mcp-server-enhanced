/**
 * @fileoverview T2.1 — Compensating snapshot/restore wrapper for tools that
 * issue more than one write in a single invocation.
 *
 * **When to use this**
 * The 7 current write tools each issue at most a single PUT per invocation,
 * so they already have transaction semantics by construction: replacements,
 * frontmatter edits, tag edits, etc. are computed entirely in memory before
 * the single PUT goes out. A mid-step failure simply throws before the PUT
 * is reached — the vault file is never touched. T2.1 is satisfied for these
 * tools without any extra wrapping.
 *
 * This helper exists for *future* tools that genuinely cannot be expressed
 * as a single PUT (e.g. cross-file moves, multi-section rewrites, or any
 * sequence where failure between writes would leave a partial state). Such a
 * tool wraps its multi-step body in `withSnapshotRestore`. On error mid-
 * sequence, the helper attempts a compensating PUT that restores the file
 * to its pre-tool state. Failures of the restore itself are logged loudly
 * but do not mask the original error.
 *
 * Note that this is a best-effort compensation, not a true atomic
 * transaction — Obsidian's REST API has no rename or commit/rollback
 * primitive. If the restore PUT itself fails (e.g. because the network is
 * down), the file may be left in a partial state. The original exception is
 * always re-thrown so the wrapper turns the failure into a structured error
 * the caller can react to.
 *
 * @module src/utils/internal/snapshotRestore
 */
import { ObsidianRestApiService } from "../../services/obsidianRestAPI/index.js";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";

export interface SnapshotRestoreOptions {
  filePath: string;
  service: ObsidianRestApiService;
  context: RequestContext;
}

/**
 * Snapshots `filePath` content, runs `fn`, and on any throw issues a
 * compensating PUT that restores the snapshot. Re-throws the original
 * error after the restore attempt completes (whether the restore succeeded
 * or not — failures only log).
 *
 * Skips compensation entirely if the snapshot read itself fails (we have
 * nothing to restore to). Callers should ensure the file exists before
 * calling.
 */
export async function withSnapshotRestore<T>(
  opts: SnapshotRestoreOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { filePath, service, context } = opts;

  let snapshot: string;
  try {
    snapshot = (await service.getFileContent(
      filePath,
      "markdown",
      context,
    )) as string;
  } catch (snapshotErr) {
    // Cannot snapshot — let the body run unwrapped. The wrapper has nothing
    // to restore to, and aborting the whole operation here would mask
    // legitimate not-found / first-write scenarios.
    logger.warning(
      `withSnapshotRestore: could not snapshot '${filePath}' before sequence; running without restore protection.`,
      {
        ...context,
        operation: "snapshotRestore",
        file: filePath,
        snapshot_error:
          snapshotErr instanceof Error
            ? snapshotErr.message
            : String(snapshotErr),
      },
    );
    return await fn();
  }

  try {
    return await fn();
  } catch (err) {
    logger.warning(
      `withSnapshotRestore: '${filePath}' threw mid-sequence; attempting compensating restore.`,
      {
        ...context,
        operation: "snapshotRestore",
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    try {
      await service.updateFileContent(filePath, snapshot, context);
      logger.info(
        `withSnapshotRestore: restored '${filePath}' to pre-tool state.`,
        { ...context, operation: "snapshotRestore", file: filePath },
      );
    } catch (restoreErr) {
      logger.error(
        `withSnapshotRestore: COMPENSATING RESTORE FAILED for '${filePath}'. The file may be in a partial state.`,
        restoreErr instanceof Error ? restoreErr : undefined,
        {
          ...context,
          operation: "snapshotRestore",
          file: filePath,
          original_error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    throw err;
  }
}
