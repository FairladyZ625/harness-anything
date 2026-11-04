import { parentPort, workerData } from "node:worker_threads";
import { installStorageWorkerContext, type StorageWorkerContext } from "../../src/storage-worker-context.ts";
import type { PGliteStorageBackendConfig } from "../../src/storage-backend.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { openPersistentWriterEpoch } from "../../src/writer-epoch.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";

const { repoId, storage, context, stateRoot } = workerData as {
  readonly repoId: string;
  readonly storage: PGliteStorageBackendConfig;
  readonly context: StorageWorkerContext;
  readonly stateRoot: string;
};
installStorageWorkerContext(context);
const authority = openPersistentWriterEpoch({ stateRoot, holderId: "writer-worker", storage }),
  lease = authority.acquire(repoId),
  store = makeTaskEventStore({ repoId, storage, writerFence: () => lease });
authority.withAppendFence(repoId, lease.epoch, lease.holderId, () => {
  store.append(bundle(eventAt(1)));
  parentPort!.postMessage({ held: true, epoch: lease.epoch });
  // The test terminates this worker here: no finally block can release its logical fence.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
