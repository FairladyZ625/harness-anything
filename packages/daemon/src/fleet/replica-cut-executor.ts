import { parentPort, workerData } from "node:worker_threads";
import { makeTaskEventReader, makeTaskProjectionReader } from "@harness-anything/kernel";
import { openReplicaCutSource } from "./replica-cut-store.ts";
import type { CutRequest, CutResponse, ReplicaCutWorkerInput } from "./replica-cut-worker.ts";

const input = workerData as ReplicaCutWorkerInput,
  port = parentPort!;
const ledger = makeTaskEventReader(input),
  reader = makeTaskProjectionReader({ rootDir: input.rootDir }),
  source = openReplicaCutSource({
    repoId: input.repoId,
    localRoot: input.localRoot,
    readSequence: (from) => reader.withSession((projection) => projection.readReplicaSequence(from)),
    readRevision: (revision) => reader.withSession((projection) => projection.readReplicaRevision(revision)),
    readLedgerCut: ledger.currentCut,
    readContentBlob: ledger.readContentBlob,
  });
port.on("message", ({ id }: { readonly id: number; readonly command: CutRequest }) => {
  try {
    port.postMessage({ id, value: source.activate() } satisfies CutResponse);
  } catch (error) {
    const response = {
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? { code: error.code }
          : {}),
      },
    } satisfies CutResponse;
    port.postMessage(response);
    return response;
  }
});
