// Public compatibility façade for the canonical task event store.
export {
  CANONICAL_EVENT_REF,
  canonicalEventEntityRefs,
  materializationStates,
  TaskEventStoreError,
  type CanonicalContentBlob,
  type CanonicalEventAppendReceipt,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type CanonicalEventStreamV1,
  type CanonicalPublicationIdentity,
  type CanonicalWriteBundle,
  type EventFileBatch,
  type EventPublicationKillpoint,
  type MaterializationReceipt,
  type MaterializationFailureReason,
  type MaterializationHealth,
  type MaterializationState,
  type PublicationFile,
  type PublicationMetrics,
  type TaskEventStoreErrorCode,
  type LedgerEventStorePort,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
export { resolveStorageBackend, unsupportedStorageBackendError } from "../storage-backend.ts";
export type {
  PGliteStorageBackendConfig,
  PostgresStorageBackendConfig,
  ResolvedStorageBackend,
  SqliteStorageBackendConfig,
  StorageBackend,
  StorageBackendConfig,
  StorageBackendOptions,
  StorageScope,
} from "../storage-backend.ts";
export {
  canonicalEventCut,
  canonicalLedgerCut,
  canonicalEventContentClaims,
  canonicalEventWritePlan,
  validateCanonicalWriteBundle,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
export { makeTaskEventReader, makeTaskEventStore, readCertifiedGitFollower } from "./task-event-store-factory.ts";
export type {
  CertifiedGitFollower,
  PostgresTaskEventStoreOptions,
  SqliteCanonicalEventStore,
  SqliteTaskEventStoreOptions,
} from "./task-event-store-factory.ts";
export {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
