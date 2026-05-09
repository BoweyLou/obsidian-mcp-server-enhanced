/**
 * T2.1 — snapshot/restore unit test.
 *
 * Closes the ship criterion: "inject failure mid-sequence → file
 * compensated back to pre-tool state". The current 7 write tools each
 * issue at most one PUT and don't need this helper, but the property is
 * worth proving here so future multi-PUT tools can rely on it.
 */
import { describe, expect, it } from "vitest";
import { withSnapshotRestore } from "../src/utils/internal/snapshotRestore.js";
import { requestContextService } from "../src/utils/internal/requestContext.js";
import type { ObsidianRestApiService } from "../src/services/obsidianRestAPI/index.js";

const ctx = () =>
  requestContextService.createRequestContext({
    operation: "snapshotRestoreTest",
  });

interface FakeFs {
  read: string;
  writes: string[];
}

function makeService(fs: FakeFs): ObsidianRestApiService {
  const stub: Partial<ObsidianRestApiService> = {
    getFileContent: async () => fs.read,
    updateFileContent: async (_p, content) => {
      fs.writes.push(content);
    },
  };
  return stub as ObsidianRestApiService;
}

describe("T2.1 withSnapshotRestore", () => {
  it("returns the body's value on success without issuing a restore", async () => {
    const fs: FakeFs = { read: "ORIGINAL", writes: [] };
    const result = await withSnapshotRestore(
      {
        filePath: "Notes/A.md",
        service: makeService(fs),
        context: ctx(),
      },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(fs.writes).toEqual([]);
  });

  it("issues a compensating restore when the body throws after writing", async () => {
    const fs: FakeFs = { read: "ORIGINAL", writes: [] };
    const service = makeService(fs);

    let thrown: unknown;
    try {
      await withSnapshotRestore(
        { filePath: "Notes/A.md", service, context: ctx() },
        async () => {
          // Simulate a multi-step body that wrote half-way then failed.
          await service.updateFileContent(
            "Notes/A.md",
            "PARTIAL_STATE",
            ctx(),
          );
          throw new Error("mid-sequence failure");
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("mid-sequence failure");
    // The first write was the partial; the second is the compensating restore.
    expect(fs.writes).toEqual(["PARTIAL_STATE", "ORIGINAL"]);
  });

  it("re-throws the original error even if the restore PUT itself fails", async () => {
    const fs: FakeFs = { read: "ORIGINAL", writes: [] };
    let updateCalls = 0;
    const service: Partial<ObsidianRestApiService> = {
      getFileContent: async () => fs.read,
      updateFileContent: async () => {
        updateCalls++;
        // First call (partial write) succeeds; second (restore) fails.
        if (updateCalls === 2) {
          throw new Error("restore network failure");
        }
      },
    };

    let thrown: unknown;
    try {
      await withSnapshotRestore(
        {
          filePath: "Notes/A.md",
          service: service as ObsidianRestApiService,
          context: ctx(),
        },
        async () => {
          await (service as ObsidianRestApiService).updateFileContent(
            "Notes/A.md",
            "PARTIAL",
            ctx(),
          );
          throw new Error("original failure");
        },
      );
    } catch (err) {
      thrown = err;
    }

    // Original error propagates, not the restore-failure error.
    expect((thrown as Error).message).toBe("original failure");
    expect(updateCalls).toBe(2); // partial + attempted restore
  });

  it("falls through (no restore) if snapshot read fails", async () => {
    let updateCalls = 0;
    const service: Partial<ObsidianRestApiService> = {
      getFileContent: async () => {
        throw new Error("file not found");
      },
      updateFileContent: async () => {
        updateCalls++;
      },
    };

    const result = await withSnapshotRestore(
      {
        filePath: "Notes/Missing.md",
        service: service as ObsidianRestApiService,
        context: ctx(),
      },
      async () => "body-ok",
    );

    expect(result).toBe("body-ok");
    expect(updateCalls).toBe(0);
  });
});
