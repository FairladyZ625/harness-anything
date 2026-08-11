// @slice-activation PLT-Bedrock W1 exposes local kernel implementation factories
// for application composition roots without making store internals public.
export { readContentAddressedBlob, readContentAddressedTextBlob, writeContentAddressedBlob } from "../store/content-addressed-blob-store.ts";
export { makeMarkdownArtifactStore } from "../store/markdown-artifact-store.ts";
export { makeJournaledWriteCoordinator } from "../store/write-journal-coordinator.ts";
export { makeLocalLockRegistry } from "../store/local-lock-registry.ts";
export { makeLocalVersionControlSystem } from "../store/local-version-control-system.ts";
export { makeTaskLeaseStore, TaskLeaseConflictError } from "../local/task-lease-store.ts";
export { defaultLifecycleTaskProjectionPath, makeTaskProjection } from "../projection/task-projection.ts";
export { makeTaskEventStore, readTaskEventStream, TaskEventStoreError } from "../store/task-event-store.ts";
