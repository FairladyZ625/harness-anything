// @slice-activation TW-01 authority application contract consumed by forced-command transport and TW-02/TW-03.
export { createInMemoryAuthorityOperationRegistry, createInMemoryReplicaChangeLog } from "./memory-stores.ts";
export { canonicalAuthorityRequestDigest, createAuthoritySubmissionService } from "./service.ts";
export {
  createInMemoryShadowPublicationLog,
  reconcileShadowPublications,
  shadowPublicationSchema,
  shadowReconciliationSchema
} from "./shadow.ts";
export type { AuthoritySubmissionServiceOptions, AuthoritySubmissionV2Options } from "./service.ts";
export * from "./actor-axes-binding-v2.ts";
export * from "./canonical-cbor.ts";
export * from "./semantic-mutation-envelope-v2.ts";
export { authorityProtocolTuple } from "./types.ts";
export type {
  AttributedCoordinatorFactory,
  AuthorityCommittedReceipt,
  AuthorityFenceWitness,
  AuthorityIndeterminateReceipt,
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
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "./types.ts";
export type {
  CanonicalPublicationObservation,
  ShadowDifference,
  ShadowDifferenceCode,
  ShadowPublicationLog,
  ShadowPublicationRecord,
  ShadowReconciliationReport
} from "./shadow.ts";
