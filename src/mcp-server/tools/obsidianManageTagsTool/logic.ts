import { z } from "zod";
import { dump } from "js-yaml";
import {
  NoteJson,
} from "../../../services/obsidianRestAPI/index.js";
import { VaultManager } from "../../../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  assertContentHash,
  expectedContentHashDescription,
  logger,
  RequestContext,
  retryWithDelay,
  retryWithExponentialBackoff,
  verifyContentMatch,
  VerificationResult,
} from "../../../utils/index.js";
import { sanitization } from "../../../utils/security/sanitization.js";

// ====================================================================================
// Schema Definitions
// ====================================================================================

const ManageTagsInputSchemaBase = z.object({
  filePath: z
    .string()
    .min(1)
    .describe(
      "The vault-relative path to the target note (e.g., 'Journal/2024-06-12.md').",
    ),
  operation: z
    .enum(["add", "remove", "list"])
    .describe(
      "The tag operation to perform: 'add' to include new tags, 'remove' to delete existing tags, or 'list' to view all current tags.",
    ),
  tags: z
    .array(z.string())
    .describe(
      "An array of tag names to be processed. The '#' prefix should be omitted (e.g., use 'project/active', not '#project/active').",
    ),
  vault: z
    .string()
    .optional()
    .describe(
      'The ID of the vault to write to (e.g., "personal", "work"). If not specified, uses the default vault.',
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional client-supplied UUID. If the same key is sent twice within 60s, the second call returns the cached result.",
    ),
  expected_content_hash: z
    .string()
    .optional()
    .describe(expectedContentHashDescription),
});

export const ObsidianManageTagsInputSchemaShape =
  ManageTagsInputSchemaBase.shape;
export const ManageTagsInputSchema = ManageTagsInputSchemaBase;

export type ObsidianManageTagsInput = z.infer<typeof ManageTagsInputSchema>;

export interface ObsidianManageTagsResponse {
  success: boolean;
  message: string;
  currentTags: string[];
  /** T1.3 — read-back verification result. */
  verification?: VerificationResult;
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

export const processObsidianManageTags = async (
  params: ObsidianManageTagsInput,
  context: RequestContext,
  vaultManager: VaultManager,
): Promise<ObsidianManageTagsResponse> => {
  const { filePath, operation, tags: inputTags, vault: vaultId } = params;

  const obsidianService = vaultManager.getVaultService(vaultId, context);
  const vaultCacheService = vaultManager.getVaultCacheService(vaultId, context);
  const vaultConfig = vaultManager.getVaultConfig(vaultId);

  logger.debug(`Processing obsidian_manage_tags request`, {
    ...context,
    ...params,
    vaultId: vaultConfig.id,
    vaultName: vaultConfig.name,
  });

  const sanitizedTags = inputTags.map((t) => sanitization.sanitizeTagName(t));

  const shouldRetryNotFound = (err: unknown) =>
    err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND;

  const getFileWithRetry = async (
    opContext: RequestContext,
    format: "json" | "markdown",
  ): Promise<NoteJson | string> => {
    return await retryWithDelay(
      () => obsidianService.getFileContent(filePath, format, opContext),
      {
        operationName: `getFileContentForTagManagement`,
        context: opContext,
        maxRetries: 3,
        delayMs: 300,
        shouldRetry: shouldRetryNotFound,
      },
    );
  };

  const initialNote = (await getFileWithRetry(context, "json")) as NoteJson;
  const currentTags = initialNote.tags;

  switch (operation) {
    case "list": {
      return {
        success: true,
        message: "Successfully listed all tags.",
        currentTags: currentTags,
      };
    }

    case "add": {
      const tagsToAdd = sanitizedTags.filter((t) => !currentTags.includes(t));
      if (tagsToAdd.length === 0) {
        return {
          success: true,
          message:
            "No new tags to add; all provided tags already exist in the note.",
          currentTags: currentTags,
        };
      }

      const frontmatter = initialNote.frontmatter ?? {};
      const frontmatterTags: string[] = Array.isArray(frontmatter.tags)
        ? frontmatter.tags
        : [];
      const newFrontmatterTags = [
        ...new Set([...frontmatterTags, ...tagsToAdd]),
      ];
      frontmatter.tags = newFrontmatterTags;

      const noteContent = (await getFileWithRetry(
        context,
        "markdown",
      )) as string;
      // T2.3: pre-flight hash check on the markdown form.
      assertContentHash(
        noteContent,
        params.expected_content_hash,
        filePath,
        context,
      );
      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
      const match = noteContent.match(frontmatterRegex);
      const newFrontmatterString = dump(frontmatter);

      let newContent;
      if (match) {
        newContent = noteContent.replace(
          frontmatterRegex,
          `---\n${newFrontmatterString}---\n`,
        );
      } else {
        newContent = `---\n${newFrontmatterString}---\n\n${noteContent}`;
      }

      // T1.2: exponential-backoff retry on the rewrite.
      await retryWithExponentialBackoff(
        () => obsidianService.updateFileContent(filePath, newContent, context),
        {
          operationName: "obsidian_manage_tags:add",
          context,
          errorContext: { file: filePath, tagsToAdd },
        },
      );

      if (vaultCacheService) {
        await vaultCacheService.updateCacheForFile(filePath, context);
      }

      // T1.3: hash-verify the post-write content.
      const addVerification = await verifyContentMatch(
        { kind: "filePath", path: filePath },
        newContent,
        obsidianService,
        { ...context, operation: "verifyContentMatch" },
      );
      if (!addVerification.verified) {
        throw new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          `Tag add reported success but read-back verification failed: ${addVerification.reason}`,
          { ...context, verification_error: true, verification: addVerification },
        );
      }

      const finalTags = [...new Set([...currentTags, ...tagsToAdd])];
      return {
        success: true,
        message: `Successfully added tags: ${tagsToAdd.join(", ")}.`,
        currentTags: finalTags,
        verification: addVerification,
      };
    }

    case "remove": {
      const tagsToRemove = sanitizedTags.filter((t) => currentTags.includes(t));
      if (tagsToRemove.length === 0) {
        return {
          success: true,
          message:
            "No tags to remove; none of the provided tags exist in the note.",
          currentTags: currentTags,
        };
      }

      let noteContent = (await getFileWithRetry(context, "markdown")) as string;
      // T2.3: pre-flight hash check on the markdown form.
      assertContentHash(
        noteContent,
        params.expected_content_hash,
        filePath,
        context,
      );
      const frontmatter = initialNote.frontmatter ?? {};
      let frontmatterTags: string[] = Array.isArray(frontmatter.tags)
        ? frontmatter.tags
        : [];
      const newFrontmatterTags = frontmatterTags.filter(
        (t) => !tagsToRemove.includes(t),
      );
      let frontmatterModified =
        newFrontmatterTags.length !== frontmatterTags.length;

      if (frontmatterModified) {
        frontmatter.tags = newFrontmatterTags;
        if (newFrontmatterTags.length === 0) {
          delete frontmatter.tags;
        }
      }

      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
      const match = noteContent.match(frontmatterRegex);

      if (frontmatterModified && match) {
        const newFrontmatterString =
          Object.keys(frontmatter).length > 0 ? dump(frontmatter) : "";
        if (newFrontmatterString) {
          noteContent = noteContent.replace(
            frontmatterRegex,
            `---\n${newFrontmatterString}---\n`,
          );
        } else {
          noteContent = noteContent.replace(frontmatterRegex, "");
        }
      }

      let inlineModified = false;
      for (const tag of tagsToRemove) {
        const regex = new RegExp(`(^|[^\\w-#])#${tag}\\b`, "g");
        if (regex.test(noteContent)) {
          noteContent = noteContent.replace(regex, "$1");
          inlineModified = true;
        }
      }

      let removeVerification: VerificationResult | undefined;
      if (frontmatterModified || inlineModified) {
        // T1.2: exponential-backoff retry on the rewrite.
        await retryWithExponentialBackoff(
          () =>
            obsidianService.updateFileContent(filePath, noteContent, context),
          {
            operationName: "obsidian_manage_tags:remove",
            context,
            errorContext: { file: filePath, tagsToRemove },
          },
        );
        // T1.3: hash-verify.
        removeVerification = await verifyContentMatch(
          { kind: "filePath", path: filePath },
          noteContent,
          obsidianService,
          { ...context, operation: "verifyContentMatch" },
        );
        if (!removeVerification.verified) {
          throw new McpError(
            BaseErrorCode.INTERNAL_ERROR,
            `Tag remove reported success but read-back verification failed: ${removeVerification.reason}`,
            {
              ...context,
              verification_error: true,
              verification: removeVerification,
            },
          );
        }
      }

      if (vaultCacheService) {
        await vaultCacheService.updateCacheForFile(filePath, context);
      }

      const finalTags = currentTags.filter((t) => !tagsToRemove.includes(t));
      return {
        success: true,
        message: `Successfully removed tags: ${tagsToRemove.join(", ")}.`,
        currentTags: finalTags,
        verification: removeVerification,
      };
    }

    default:
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Invalid operation: ${operation}`,
        context,
      );
  }
};
