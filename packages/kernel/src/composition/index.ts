// @slice-activation PLT-Bedrock W1 exposes local kernel implementation factories
// for application composition roots without making store internals public.
export { readContentAddressedBlob, readContentAddressedTextBlob, writeContentAddressedBlob } from "../store/content-addressed-blob-store.ts";
export { makeMarkdownArtifactStore } from "../store/markdown-artifact-store.ts";
export { makeJournaledWriteCoordinator } from "../store/write-journal-coordinator.ts";
export { makeLocalLockRegistry } from "../store/local-lock-registry.ts";
export { makeTaskProjection } from "../projection/task-projection.ts";
export { makeTaskEventStore, TaskEventStoreError } from "../store/task-event-store.ts";
export type { EventPublicationKillpoint } from "../store/task-event-store.ts";
