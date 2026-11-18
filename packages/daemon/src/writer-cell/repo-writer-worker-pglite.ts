import { workerData } from "node:worker_threads";
import { bindPGliteCommitContext, type PGliteCommitContext } from "@harness-anything/storage/pglite/worker";
import {
  closeWriterEpochFenceDescriptors,
  configureWriterEpochStorage,
  makePgCanonicalEventStore,
  storageForWriter,
  withWriterEpochFenceDescriptor,
  withStorageWriteRequestSync,
} from "@harness-anything/storage/pg";
import { startCanonicalCommitWorker } from "./canonical-commit-worker.ts";
import { observeWorkerMemory } from "./daemon-diagnostics-memory.ts";

const context = (workerData as { storageContext?: PGliteCommitContext }).storageContext;
if (!context) throw new Error("PGlite Writer requires the existing embedded owner's port");
const createReader = bindPGliteCommitContext(context);
observeWorkerMemory();
startCanonicalCommitWorker({
  open: (config, writerFence) => {
    const storage = storageForWriter(config.storage, "pglite");
    if (config.defaultWriterEpochFence) configureWriterEpochStorage(config.defaultWriterEpochFence, storage);
    return makePgCanonicalEventStore({
      repoId: config.repoId,
      rootDir: config.rootDir,
      storage,
      writerFence,
      createReader,
    });
  },
  withFence: withWriterEpochFenceDescriptor,
  closeFences: closeWriterEpochFenceDescriptors,
  withWriteRequest: withStorageWriteRequestSync,
});
