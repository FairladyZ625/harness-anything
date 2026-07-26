// @slice-activation PLT-Bedrock W1 exposes local kernel implementation factories
// for application composition roots without making store internals public.
export {
  readContentAddressedBlob,
  readContentAddressedTextBlob,
  removeContentAddressedBlob,
  writeContentAddressedBlobWithDisposition
} from "../persistence/blob/content-addressed-blob-store.ts";
export type {
  ContentAddressedBlobWriteResult
} from "../persistence/blob/content-addressed-blob-store.ts";
export { collectCasGarbage } from "../persistence/blob/cas-garbage-collector.ts";
export type {
  CasGarbageCollectionEntry,
  CasGarbageCollectionReport
} from "../persistence/blob/cas-garbage-collector.ts";
export { makeMarkdownArtifactStore } from "../persistence/markdown/markdown-artifact-store.ts";
export { makeJournaledWriteCoordinator, makeOperationalJournaledWriteCoordinator } from "../write-coordination/journal/coordinator.ts";
export { makeLocalLockRegistry } from "../persistence/local/local-lock-registry.ts";
export { makeLocalVersionControlSystem } from "../persistence/git/local-version-control-system.ts";
export { makeLocalAuthorityAttributionEventV2Log } from "../write-coordination/attribution/authority-attribution-event-v2-log.ts";
export type { AuthorityAttributionEventV2Log } from "../write-coordination/attribution/authority-attribution-event-v2-log.ts";
