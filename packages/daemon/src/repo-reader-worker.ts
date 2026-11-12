import { observeWorkerMemory } from "./daemon-diagnostics-memory.ts";
import { parentPort, workerData } from "node:worker_threads";
import { installStorageWorkerContext } from "@harness-anything/storage";
import { executeRepoReadRequest } from "./repo-read-worker.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  serializeWriterError,
  type RepoWriterBootstrapV1,
  type RepoWriterRequestV1,
  type RepoWriterReceiptV1,
} from "./repo-writer-protocol.ts";

observeWorkerMemory();

const bootstrap = workerData as RepoWriterBootstrapV1;
installStorageWorkerContext(bootstrap.storageContext);
parentPort!.on("message", async (request: RepoWriterRequestV1) => {
  if (request.schema !== "harness-repo-writer-request/v1") return;
  parentPort!.postMessage(await readReceipt(request));
});

async function readReceipt(request: RepoWriterRequestV1): Promise<RepoWriterReceiptV1> {
  const receipt = {
    schema: "harness-repo-writer-receipt/v1",
    protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
    requestId: request.requestId,
  } as const;
  try {
    if (request.method !== "read") throw new Error("Reader worker only accepts query requests.");
    return { ...receipt, outcome: "ok", value: await executeRepoReadRequest(request) };
  } catch (error) {
    return { ...receipt, outcome: "error", error: serializeWriterError(error) };
  }
}
parentPort!.postMessage({
  schema: "harness-repo-writer-status/v1",
  protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
  kind: "attach-progress",
});
