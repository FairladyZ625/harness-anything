import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { makeTaskEventStore as makeGitEventStore } from "../../kernel/src/store/task-event-store.ts";
import type {
  WalMaterializationRequestV1,
  WalMaterializationWorkerConfig,
} from "../../kernel/src/store/wal-materialization-protocol.ts";
import {
  runWalMaterializationRequest,
  WAL_MATERIALIZATION_WORKER_KIND,
} from "../../kernel/src/store/wal-materialization-worker.ts";
import { scanAuthoredCandidateInventory } from "./doc-sync-candidate-scanner.ts";
import { withWriterEpochFenceDescriptor } from "./writer-epoch.ts";

if (!isMainThread && workerData?.kind === WAL_MATERIALIZATION_WORKER_KIND && workerData?.entry === "custom") {
  const config = workerData.config as WalMaterializationWorkerConfig;
  parentPort!.on("message", (message: WalMaterializationRequestV1) => {
    const response = runWalMaterializationRequest(config, message, {
      withFinalizeFence: (fence, operation) => withWriterEpochFenceDescriptor(fence, operation),
    });
    if (response.outcome !== "materialized" || response.settlementIntent === null) {
      parentPort!.postMessage(response);
      return;
    }
    try {
      const store = makeGitEventStore({
        repoId: config.repoId,
        rootDir: config.rootDir,
        ...(config.authoredBranch ? { authoredBranch: config.authoredBranch } : {}),
      });
      parentPort!.postMessage({
        ...response,
        settlementIntent: {
          ...response.settlementIntent,
          inventory: scanAuthoredCandidateInventory({ rootDir: config.rootDir, store }),
        },
      });
    } catch (error) {
      console.warn(
        `[wal-materializer] authored candidate inventory failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      parentPort!.postMessage({ ...response, settlementIntent: null });
    }
  });
  parentPort!.postMessage({ schema: "harness-wal-materialization-worker-ready/v1" });
}
