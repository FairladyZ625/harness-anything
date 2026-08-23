// Public compatibility façade for the canonical task event store.
export {
  CANONICAL_EVENT_REF,
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
  type EventRecoveryReceipt,
  type MaterializationReceipt,
  type PublicationMetrics,
  type TaskEventStoreErrorCode,
} from "./task-event-store-types.ts";
export {
  canonicalEventContentClaims,
  canonicalEventWritePlan,
  validateCanonicalWriteBundle,
} from "./task-event-store-contract.ts";
export { makeTaskEventStore } from "./task-event-store-factory.ts";
export { canonicalDocumentClaims, canonicalDocumentRetirements } from "./task-event-store-claims-layout.ts";
export { canonicalDocumentMode } from "./task-event-store-materialization.ts";
export { canonicalEventCut, canonicalLedgerCut } from "./task-event-store-reads.ts";
