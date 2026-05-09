/**
 * @fileoverview T1.1 — Periodic keepalive ping against the Obsidian REST API.
 *
 * BUG-016 root-cause hypothesis: at high context-token volume, the axios
 * connection pool to the Obsidian REST API goes idle long enough to be reaped
 * by the OS / plugin, and the next write stalls or fails. Sending a no-op GET
 * to each configured vault every 30s keeps the pool warm and surfaces upstream
 * outages in the logs before they hit a user-visible write.
 *
 * @module src/utils/internal/keepalive
 */
import { VaultManager } from "../../services/vaultManager/index.js";
import { logger } from "./logger.js";
import { requestContextService } from "./requestContext.js";

const DEFAULT_INTERVAL_MS = 30_000;

let intervalHandle: NodeJS.Timeout | null = null;
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;
let lastFailureReason: string | null = null;

export interface KeepaliveStatus {
  running: boolean;
  intervalMs: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
}

export function startKeepalive(
  vaultManager: VaultManager,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  if (intervalHandle) {
    logger.debug(
      "Keepalive already running, ignoring duplicate start.",
      requestContextService.createRequestContext({
        operation: "Keepalive_StartIgnored",
      }),
    );
    return;
  }

  const tick = async () => {
    const vaultIds = vaultManager.getAvailableVaults();
    for (const vaultId of vaultIds) {
      const ctx = requestContextService.createRequestContext({
        operation: "Keepalive_Ping",
        vaultId,
      });
      try {
        const service = vaultManager.getVaultService(vaultId, ctx);
        await service.checkStatus(ctx);
        lastSuccessAt = Date.now();
        // Don't log every successful ping — too noisy. Debug only.
        logger.debug(`Keepalive ping ok for vault '${vaultId}'`, ctx);
      } catch (err) {
        lastFailureAt = Date.now();
        lastFailureReason = err instanceof Error ? err.message : String(err);
        logger.warning(
          `Keepalive ping failed for vault '${vaultId}': ${lastFailureReason}`,
          ctx,
        );
      }
    }
  };

  intervalHandle = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof intervalHandle.unref === "function") intervalHandle.unref();

  // Run once immediately so the first ping doesn't wait 30s.
  void tick();

  logger.info(
    `Keepalive started: pinging ${vaultManager.getAvailableVaults().length} vault(s) every ${intervalMs}ms`,
    requestContextService.createRequestContext({
      operation: "Keepalive_Start",
      intervalMs,
    }),
  );
}

export function stopKeepalive(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info(
      "Keepalive stopped.",
      requestContextService.createRequestContext({
        operation: "Keepalive_Stop",
      }),
    );
  }
}

export function getKeepaliveStatus(): KeepaliveStatus {
  return {
    running: intervalHandle !== null,
    intervalMs: DEFAULT_INTERVAL_MS,
    lastSuccessAt,
    lastFailureAt,
    lastFailureReason,
  };
}

/** Test-only — clears keepalive state. */
export function _resetKeepaliveForTests(): void {
  stopKeepalive();
  lastSuccessAt = null;
  lastFailureAt = null;
  lastFailureReason = null;
}
