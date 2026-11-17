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

observeWorkerMemory();
startCanonicalCommitWorker({
  open: (config, writerFence) => {
    const storage = storageForWriter(config.storage, "postgres");
    if (config.defaultWriterEpochFence) configureWriterEpochStorage(config.defaultWriterEpochFence, storage);
    return makePgCanonicalEventStore({
      repoId: config.repoId,
      rootDir: config.rootDir,
      storage,
      writerFence,
    });
  },
  withFence: withWriterEpochFenceDescriptor,
  closeFences: closeWriterEpochFenceDescriptors,
  withWriteRequest: withStorageWriteRequestSync,
});
