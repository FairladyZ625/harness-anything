// @slice-activation PLT-Bedrock W1 exposes local kernel implementation factories
// for application composition roots without making store internals public.
import { makeTaskLeaseStoreAdapter, type TaskLeaseStoreOptions } from "../local/task-lease-store.ts";
import { readEffectiveTaskLease, readStoredTaskLease } from "../store/task-lease-cas.ts";
export { readContentAddressedBlob, readContentAddressedTextBlob, writeContentAddressedBlob } from "../store/content-addressed-blob-store.ts";
export { makeMarkdownArtifactStore } from "../store/markdown-artifact-store.ts";
export { makeJournaledWriteCoordinator } from "../store/write-journal-coordinator.ts";
export { makeLocalLockRegistry } from "../store/local-lock-registry.ts";
export function makeTaskLeaseStore(options: Omit<TaskLeaseStoreOptions, "readEffectiveLease" | "readStoredLease">) {
  return makeTaskLeaseStoreAdapter({ ...options, readEffectiveLease: readEffectiveTaskLease, readStoredLease: readStoredTaskLease });
}
export { makeTaskProjection } from "../projection/task-projection.ts";
export { makeTaskEventStore, TaskEventStoreError } from "../store/task-event-store.ts";
