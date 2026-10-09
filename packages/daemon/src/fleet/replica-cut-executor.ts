import { parentPort, workerData } from "node:worker_threads";
import { makeTaskEventReader, makeTaskProjectionReader, type TaskProjectionQueries } from "@harness-anything/kernel";
import { openReplicaCutSource } from "./replica-cut-store.ts";
import { centerEdgeReadModel } from "./replica-read-model.ts";
import type { CutRequest, CutResponse, ReplicaCutWorkerInput } from "./replica-cut-worker.ts";

const input = workerData as ReplicaCutWorkerInput,
  port = parentPort!;
let projection: TaskProjectionQueries | null = null;
const ledger = makeTaskEventReader(input),
  reader = makeTaskProjectionReader({ rootDir: input.rootDir }),
  source = openReplicaCutSource({
    repoId: input.repoId,
    localRoot: input.localRoot,
    withReadSnapshot: (read) =>
      reader.withSession((current) => {
        projection = current;
        try {
          return read();
        } finally {
          projection = null;
        }
      }),
    readBasis: (after) => projection!.readReplicaBasis(after),
    readLedgerCut: ledger.currentCut,
    readContentBlob: ledger.readContentBlob,
    readEdgeReadModel: (read) => centerEdgeReadModel(projection!, read),
  });
port.on("message", async ({ id, command }: { readonly id: number; readonly command: CutRequest }) => {
  try {
    let value: unknown;
    switch (command.kind) {
      case "activate":
        value = source.activate();
        break;
      case "kick":
        source.kick();
        break;
      case "wait":
        value = await source.waitForCut(command.revision);
        break;
      case "releasePin":
        source.releasePin(command.lease);
        break;
      case "pin":
        value = await source.pin(command.lease, command.from, command.quota, command.leaseRoot);
        break;
    }
    if (value instanceof Uint8Array) {
      const bytes = Uint8Array.from(value);
      port.postMessage({ id, value: bytes } satisfies CutResponse, [bytes.buffer]);
    } else port.postMessage({ id, value } satisfies CutResponse);
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
