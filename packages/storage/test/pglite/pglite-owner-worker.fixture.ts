import { openFleetStorage } from "../../src/storage-daemon-composition.ts";
import { parentPort, workerData } from "node:worker_threads";
import { installStorageWorkerContext, type StorageWorkerContext } from "../../src/storage-worker-context.ts";
import type { PGliteStorageBackendConfig } from "../../src/storage-backend.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { openPersistentWriterEpoch } from "../../src/writer-epoch.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";
import { makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";

const { repoId, storage, context, stateRoot, backupDirectory, readHeld } = workerData as {
  readonly repoId: string;
  readonly storage: PGliteStorageBackendConfig;
  readonly context: StorageWorkerContext;
  readonly stateRoot: string;
  readonly backupDirectory?: string;
  readonly readHeld?: boolean;
};
installStorageWorkerContext(context);
if (readHeld) {
  const outer = makeTaskProjectionReader({ repoId, storage }),
    inner = makeTaskProjectionReader({ repoId, storage });
  outer.withSession(() =>
    inner.withSession((queries) => {
      queries.readCut();
      parentPort!.postMessage({ readHeld: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }),
  );
} else if (backupDirectory) {
  const source = openFleetStorage({ rootDir: stateRoot, repoId, storage });
  try {
    const backup = await source.startBackup(backupDirectory, "unused"),
      archive = await backup.complete;
    parentPort!.postMessage({ revision: backup.metadata.position.revision, size: archive.size });
  } finally {
    source.close();
    parentPort!.close();
  }
} else {
  const authority = openPersistentWriterEpoch({ stateRoot, holderId: "writer-worker", storage }),
    lease = authority.acquire(repoId),
    store = makeTaskEventStore({ repoId, storage, writerFence: () => lease });
  authority.withAppendFence(repoId, lease.epoch, lease.holderId, () => {
    store.append(bundle(eventAt(1)));
    parentPort!.postMessage({ held: true, epoch: lease.epoch });
    // The test terminates this worker here: no finally block can release its logical fence.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}
