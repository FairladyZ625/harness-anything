import {
  activateEmptyCanonicalGeneration,
  closeWriterEpochFenceDescriptors,
  makeSqliteTaskEventStore,
  storageForWriter,
  withWriterEpochFenceDescriptor,
} from "@harness-anything/storage/sqlite";
import { startCanonicalCommitWorker } from "./canonical-commit-worker.ts";
import { observeWorkerMemory } from "./daemon-diagnostics-memory.ts";

observeWorkerMemory();
startCanonicalCommitWorker({
  open: (config, writerFence) => {
    return makeSqliteTaskEventStore({
      storage: storageForWriter(config.storage, "sqlite"),
      repoId: config.repoId,
      rootDir: config.rootDir,
      authoredBranch: config.authoredBranch,
      activationPreflight: activateEmptyCanonicalGeneration,
      writerFence,
    });
  },
  withFence: withWriterEpochFenceDescriptor,
  closeFences: closeWriterEpochFenceDescriptors,
});
