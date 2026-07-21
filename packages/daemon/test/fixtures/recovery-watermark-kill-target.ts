import { writeFileSync } from "node:fs";
import { recoverPendingProductionEvents } from "../../src/authority/production/recovery.ts";
import type { GitCanonicalPublicationInspector } from "../../src/authority/production/publication-evidence.ts";

const [watermarkPath, readyPath] = process.argv.slice(2);
if (!watermarkPath || !readyPath) throw new Error("recovery watermark kill fixture requires watermark and ready paths");
let generationFenceHeld = false;

const keepAlive = setInterval(() => undefined, 1_000);
await recoverPendingProductionEvents({
  workspaceId: "workspace-production",
  operationRegistry: {
    get: async () => undefined,
    list: async () => [],
    put: async () => undefined
  },
  replicaChangeLog: {} as never,
  eventLog: {} as never,
  publicationInspector: {
    scanFirstParentOperationAnchors: async ({ onProgress }) => {
      await onProgress?.({
        commitSha: "a".repeat(40),
        scannedCommitCount: 128,
        anchors: []
      });
      writeFileSync(readyPath, "ready\n");
      await new Promise<never>(() => undefined);
    }
  } as GitCanonicalPublicationInspector,
  recover: async () => { throw new Error("fixture has no pending operations"); },
  generationFence: {
    assertHeld: async () => {
      if (!generationFenceHeld) throw new Error("incremental watermark write escaped its generation fence");
    },
    runExclusive: async (_stage, _identity, operation) => {
      generationFenceHeld = true;
      try {
        return await operation();
      } finally {
        generationFenceHeld = false;
      }
    }
  },
  watermarkPath
}).finally(() => clearInterval(keepAlive));
