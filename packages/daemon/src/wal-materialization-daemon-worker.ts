import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  consumeKnownError,
  makeGitEventStore,
  runWalMaterializationRequest,
  WAL_MATERIALIZATION_WORKER_KIND,
  type WalMaterializationRequestV1,
  type WalMaterializationWorkerConfig,
} from "../../kernel/src/index.ts";
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
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[wal-materializer] authored candidate inventory failed: ${message}`);
      consumeKnownError(error);
      parentPort!.postMessage({ ...response, settlementIntent: null });
    }
  });
  parentPort!.postMessage({ schema: "harness-wal-materialization-worker-ready/v1" });
}
