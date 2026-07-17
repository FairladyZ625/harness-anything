// @slice-activation TW-01 authority application contract consumed by forced-command transport and TW-02/TW-03.
export { createInMemoryAuthorityOperationRegistry, createInMemoryReplicaChangeLog } from "./memory-stores.ts";
export { canonicalAuthorityRequestDigest, createAuthoritySubmissionService } from "./service.ts";
export { makeCompositeAuthoritySemanticCompilerV2 } from "./composite-semantic-compiler-v2.ts";
export {
  completeAuthorityCommittedReceiptV2,
  isCompleteAuthorityCommittedReceiptV2
} from "./committed-event-publication-v2.ts";
export {
  createDurableAuthorityCommittedEventPublisherV2
} from "./durable-committed-event-publisher-v2.ts";
export type {
  AuthorityCommittedPhysicalObservationPortV2,
  AuthorityCommittedPhysicalObservationV2
} from "./durable-committed-event-publisher-v2.ts";
export type { AuthoritySemanticCompilerRouteV2 } from "./composite-semantic-compiler-v2.ts";
export {
  attributionShadowComparisonSchema,
  compareAttributionShadow,
  createInMemoryShadowPublicationLog,
  reconcileShadowPublications,
  shadowPublicationSchema,
  shadowReconciliationSchema
} from "./shadow.ts";
export type { AuthoritySubmissionServiceOptions, AuthoritySubmissionV2Options } from "./service.ts";
export * from "./actor-axes-binding-v2.ts";
export * from "./key-registry-v1.ts";
export * from "./key-lifecycle-v1.ts";
export * from "./canonical-cbor.ts";
export * from "./semantic-mutation-envelope-v2.ts";
export { authorityProtocolTuple } from "./types.ts";
export * from "./cutover-control.ts";
export { createAuthorityCutoverEntityRegistryQualification } from "./cutover-registry-qualification.ts";
export type {
  AttributedCoordinatorFactory,
  AuthorityCommittedEventPublisherV2,
  AuthorityCommittedReceipt,
  AuthorityFenceWitness,
  AuthorityIndeterminateReceipt,
  AuthorityIntegrityTupleV2,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityOperationRecord,
  AuthorityStoredOperationRecord,
  AuthorityOperationRegistry,
  AuthorityOperationState,
  AuthorityProtocolTuple,
  AuthorityRejectedReceipt,
  AuthorityRetryableReceipt,
  AuthoritySubmissionService,
  CanonicalPublication,
  CanonicalPublicationInspector,
  DelegationTokenClaims,
  DelegationTokenVerification,
  DelegationTokenVerifier,
  RecordedAuthorityProtocol,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "./types.ts";
export type {
  AttributionShadowComparison,
  AttributionShadowDigestObservation,
  AttributionShadowMismatchField,
  AttributionShadowTelemetry,
  CanonicalPublicationObservation,
  ShadowDifference,
  ShadowDifferenceCode,
  ShadowPublicationLog,
  ShadowPublicationRecord,
  ShadowReconciliationReport
} from "./shadow.ts";
