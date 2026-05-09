/**
 * T2.3 — content hash pre-flight unit tests.
 *
 * Covers the ship criterion: "modify file between read and write → abort".
 * `assertContentHash` is the in-memory variant used by tools that have
 * already read the content; `preflightContentHash` does its own read.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  assertContentHash,
  HashMismatchError,
  preflightContentHash,
} from "../src/utils/internal/contentHashPreflight.js";
import { requestContextService } from "../src/utils/internal/requestContext.js";
import type { ObsidianRestApiService } from "../src/services/obsidianRestAPI/index.js";

const ctx = () =>
  requestContextService.createRequestContext({
    operation: "hashPreflightTest",
  });

const sha256Hex = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

describe("T2.3 assertContentHash", () => {
  it("is a no-op when expectedHashHex is undefined", () => {
    expect(() =>
      assertContentHash("anything", undefined, "file.md", ctx()),
    ).not.toThrow();
  });

  it("is a no-op when expectedHashHex is empty/whitespace", () => {
    expect(() =>
      assertContentHash("anything", "   ", "file.md", ctx()),
    ).not.toThrow();
  });

  it("passes when hashes match (case-insensitive)", () => {
    const content = "hello world";
    const hashUpper = sha256Hex(content).toUpperCase();
    expect(() =>
      assertContentHash(content, hashUpper, "file.md", ctx()),
    ).not.toThrow();
  });

  it("throws HashMismatchError on mismatch with hash_mismatch error_type", () => {
    const content = "hello world";
    const wrongHash = sha256Hex("different content");
    let thrown: unknown;
    try {
      assertContentHash(content, wrongHash, "file.md", ctx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HashMismatchError);
    const e = thrown as HashMismatchError;
    expect(e.structured.error_type).toBe("hash_mismatch");
    expect(e.structured.retry_safe).toBe(false);
    expect(e.structured.context.expected_hash).toBe(wrongHash);
    expect(e.structured.context.actual_hash).toBe(sha256Hex(content));
  });
});

describe("T2.3 preflightContentHash", () => {
  function makeStubService(content: string): ObsidianRestApiService {
    const stub: Partial<ObsidianRestApiService> = {
      getFileContent: async () => content,
    };
    return stub as ObsidianRestApiService;
  }

  it("reads file content and passes when hash matches", async () => {
    const content = "vault file body";
    const service = makeStubService(content);
    await expect(
      preflightContentHash(
        { kind: "filePath", path: "Notes/A.md" },
        sha256Hex(content),
        service,
        ctx(),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws HashMismatchError when current content differs", async () => {
    const service = makeStubService("file actually contains this");
    await expect(
      preflightContentHash(
        { kind: "filePath", path: "Notes/A.md" },
        sha256Hex("caller thought it was this"),
        service,
        ctx(),
      ),
    ).rejects.toBeInstanceOf(HashMismatchError);
  });

  it("propagates read errors verbatim (does not turn into hash_mismatch)", async () => {
    const service: Partial<ObsidianRestApiService> = {
      getFileContent: async () => {
        throw new Error("network down");
      },
    };
    await expect(
      preflightContentHash(
        { kind: "filePath", path: "Notes/A.md" },
        sha256Hex("anything"),
        service as ObsidianRestApiService,
        ctx(),
      ),
    ).rejects.toThrow("network down");
  });

  it("is a no-op when expectedHashHex is undefined (does not even read)", async () => {
    let getCalls = 0;
    const service: Partial<ObsidianRestApiService> = {
      getFileContent: async () => {
        getCalls++;
        return "anything";
      },
    };
    await preflightContentHash(
      { kind: "filePath", path: "Notes/A.md" },
      undefined,
      service as ObsidianRestApiService,
      ctx(),
    );
    expect(getCalls).toBe(0);
  });
});
