import { parentPort } from "node:worker_threads";
import {
  runLedgerMaterializer
} from "@harness-anything/kernel";

interface WorkerMaterializerOptions {
  readonly dryRun?: boolean;
  readonly maxBranches?: number;
  readonly sessionId?: string;
  readonly heldGlobalLock?: {
    readonly path: string;
    readonly ownerToken: string;
    readonly ownerKind?: "daemon";
  };
}

interface MaterializerWorkerRequest {
  readonly kind: "run";
  readonly jobId: number;
  readonly rootInput: Parameters<typeof runLedgerMaterializer>[0];
  readonly options: WorkerMaterializerOptions;
}

if (!parentPort) throw new Error("REPO_MATERIALIZER_WORKER_PARENT_PORT_MISSING");

parentPort.on("message", (request: MaterializerWorkerRequest) => {
  if (request.kind !== "run") return;
  try {
    const report = runLedgerMaterializer(request.rootInput, {
      ...request.options,
      onProgress: (value) => parentPort!.postMessage({ kind: "progress", jobId: request.jobId, value }),
      onProjectionPhase: (value) => parentPort!.postMessage({ kind: "projection-phase", jobId: request.jobId, value }),
      onProjectionMode: (mode, reason) => parentPort!.postMessage({ kind: "projection-mode", jobId: request.jobId, mode, reason }),
      onProjectionAttributionDecision: (value) => parentPort!.postMessage({ kind: "attribution-decision", jobId: request.jobId, value }),
      onProjectionDiagnostic: (value) => parentPort!.postMessage({ kind: "projection-diagnostic", jobId: request.jobId, value })
    });
    parentPort!.postMessage({ kind: "complete", jobId: request.jobId, report });
  } catch (error) {
    parentPort!.postMessage({
      kind: "failed",
      jobId: request.jobId,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    });
  }
});
