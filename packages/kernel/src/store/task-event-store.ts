// Public compatibility façade for the canonical task event store.
export {
  CANONICAL_EVENT_REF,
  canonicalEventEntityRefs,
  materializationStates,
  TaskEventStoreError,
  resolveStorageBackend,
  unsupportedStorageBackendError,
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
  type PostgresStorageBackendConfig,
  type ResolvedStorageBackend,
  type SqliteStorageBackendConfig,
  type StorageBackend,
  type StorageBackendConfig,
  type StorageBackendOptions,
  type StorageScope,
} from "./task-event-store-types.ts";
export {
  canonicalEventCut,
  canonicalLedgerCut,
  canonicalEventContentClaims,
  canonicalEventWritePlan,
  validateCanonicalWriteBundle,
} from "./task-event-store-contract.ts";
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
} from "./task-event-store-claims-layout.ts";
