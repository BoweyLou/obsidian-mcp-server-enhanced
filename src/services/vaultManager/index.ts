/**
 * @module VaultManager Service
 * @description
 * Manages multiple Obsidian vault connections and provides vault selection logic.
 * This service creates and manages multiple ObsidianRestApiService instances,
 * one for each configured vault.
 */

import { config, VaultConfig } from "../../config/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../utils/index.js";
import { ObsidianRestApiService } from "../obsidianRestAPI/index.js";
import { VaultCacheService } from "../obsidianRestAPI/vaultCache/index.js";

export class VaultManager {
  private vaultServices: Map<string, ObsidianRestApiService> = new Map();
  private vaultCacheServices: Map<string, VaultCacheService> = new Map();
  private defaultVaultId: string;

  constructor() {
    this.defaultVaultId = config.vaultConfigs[0].id;
    this.initializeVaultServices();
  }

  /**
   * Initialize ObsidianRestApiService instances for each configured vault.
   * @private
   */
  private initializeVaultServices(): void {
    const context = requestContextService.createRequestContext({
      operation: "VaultManager_Initialize",
    });

    logger.info(
      `Initializing VaultManager with ${config.vaultConfigs.length} vault(s)`,
      context,
    );

    for (const vaultConfig of config.vaultConfigs) {
      try {
        // Create a custom ObsidianRestApiService for this vault
        const vaultService = new ObsidianRestApiService(
          vaultConfig.apiKey,
          vaultConfig.baseUrl,
          vaultConfig.verifySsl,
        );

        this.vaultServices.set(vaultConfig.id, vaultService);

        // Create VaultCacheService for this vault if caching is enabled
        if (config.obsidianEnableCache) {
          const vaultCacheService = new VaultCacheService(
            vaultService,
            vaultConfig.id, // Pass vault ID for cache key prefixing
          );
          this.vaultCacheServices.set(vaultConfig.id, vaultCacheService);
        }

        logger.info(
          `Initialized vault service for vault: ${vaultConfig.id} (${vaultConfig.name})`,
          {
            ...context,
            vaultId: vaultConfig.id,
            vaultName: vaultConfig.name,
            baseUrl: vaultConfig.baseUrl,
          },
        );
      } catch (error) {
        logger.error(
          `Failed to initialize vault service for vault: ${vaultConfig.id}`,
          {
            ...context,
            vaultId: vaultConfig.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
    }
  }

  /**
   * Get the ObsidianRestApiService for a specific vault.
   * @param vaultId - The ID of the vault. If not provided, uses the default vault.
   * @param context - Request context for logging.
   * @returns The ObsidianRestApiService instance for the vault.
   * @throws {McpError} If the vault ID is invalid.
   */
  public getVaultService(
    vaultId?: string,
    context?: RequestContext,
  ): ObsidianRestApiService {
    const targetVaultId = vaultId || this.defaultVaultId;
    const service = this.vaultServices.get(targetVaultId);

    if (!service) {
      const availableVaults = Array.from(this.vaultServices.keys());
      logger.error(
        `Vault service not found for vault ID: ${targetVaultId}`,
        context ? {
          ...context,
          vaultId: targetVaultId,
          availableVaults,
        } : requestContextService.createRequestContext({
          operation: "getVaultService",
          vaultId: targetVaultId,
          availableVaults,
        }),
      );
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Vault '${targetVaultId}' not found. Available vaults: ${availableVaults.join(", ")}`,
        { vaultId: targetVaultId, availableVaults },
      );
    }

    return service;
  }

  /**
   * Get the VaultCacheService for a specific vault.
   * @param vaultId - The ID of the vault. If not provided, uses the default vault.
   * @param context - Request context for logging.
   * @returns The VaultCacheService instance for the vault, or undefined if caching is disabled.
   * @throws {McpError} If the vault ID is invalid.
   */
  public getVaultCacheService(
    vaultId?: string,
    context?: RequestContext,
  ): VaultCacheService | undefined {
    const targetVaultId = vaultId || this.defaultVaultId;
    
    if (!config.obsidianEnableCache) {
      return undefined;
    }

    const service = this.vaultCacheServices.get(targetVaultId);

    if (!service) {
      const availableVaults = Array.from(this.vaultCacheServices.keys());
      logger.error(
        `Vault cache service not found for vault ID: ${targetVaultId}`,
        context ? {
          ...context,
          vaultId: targetVaultId,
          availableVaults,
        } : requestContextService.createRequestContext({
          operation: "getVaultCacheService",
          vaultId: targetVaultId,
          availableVaults,
        }),
      );
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Vault cache '${targetVaultId}' not found. Available vaults: ${availableVaults.join(", ")}`,
        { vaultId: targetVaultId, availableVaults },
      );
    }

    return service;
  }

  /**
   * Get the configuration for a specific vault.
   * @param vaultId - The ID of the vault. If not provided, uses the default vault.
   * @returns The vault configuration.
   * @throws {McpError} If the vault ID is invalid.
   */
  public getVaultConfig(vaultId?: string): VaultConfig {
    const targetVaultId = vaultId || this.defaultVaultId;
    const vaultConfig = config.vaultConfigs.find(v => v.id === targetVaultId);

    if (!vaultConfig) {
      const availableVaults = config.vaultConfigs.map(v => v.id);
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Vault configuration '${targetVaultId}' not found. Available vaults: ${availableVaults.join(", ")}`,
        { vaultId: targetVaultId, availableVaults },
      );
    }

    return vaultConfig;
  }

  /**
   * Get all available vault IDs.
   * @returns Array of vault IDs.
   */
  public getAvailableVaults(): string[] {
    return Array.from(this.vaultServices.keys());
  }

  /**
   * Get all vault configurations.
   * @returns Array of vault configurations.
   */
  public getAllVaultConfigs(): VaultConfig[] {
    return config.vaultConfigs;
  }

  /**
   * Get the default vault ID.
   * @returns The default vault ID.
   */
  public getDefaultVaultId(): string {
    return this.defaultVaultId;
  }

  /**
   * Check if a vault ID is valid.
   * @param vaultId - The vault ID to check.
   * @returns True if the vault ID is valid, false otherwise.
   */
  public isValidVaultId(vaultId: string): boolean {
    return this.vaultServices.has(vaultId);
  }

  /**
   * Build cache for all vaults (if caching is enabled).
   * @param context - Request context for logging.
   */
  public async buildAllVaultCaches(context?: RequestContext): Promise<void> {
    if (!config.obsidianEnableCache) {
      logger.info("Vault caching is disabled, skipping cache build", context);
      return;
    }

    const buildPromises = Array.from(this.vaultCacheServices.entries()).map(
      async ([vaultId, cacheService]) => {
        try {
          logger.info(`Building cache for vault: ${vaultId}`, context ? {
            ...context,
            vaultId,
          } : requestContextService.createRequestContext({
            operation: "buildAllVaultCaches",
            vaultId,
          }));
          await cacheService.buildVaultCache();
        } catch (error) {
          logger.error(`Failed to build cache for vault: ${vaultId}`, context ? {
            ...context,
            vaultId,
            error: error instanceof Error ? error.message : String(error),
          } : requestContextService.createRequestContext({
            operation: "buildAllVaultCaches",
            vaultId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      },
    );

    await Promise.allSettled(buildPromises);
  }
}